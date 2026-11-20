#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot maintainer script; synchronous Node APIs keep it small.
// fork: keeps upstream's GT catalogs in step with T3 Extend's source. Run after every upstream sync,
// once conflicts in apps/*/src/i18n/translations are resolved by taking upstream's side.
//
// 1. `gt generate` writes en.json from the source, as `vp run i18n:generate` would.
// 2. A key that is new because the fork rewords upstream's text (T3 Extend, `t3x`) inherits each
//    locale's translation of upstream's wording, with the same rewording applied.
// 3. zh.json takes the fork's terms and whole-message overrides from
//    packages/client-runtime/src/i18n/gt-zh-overrides.json, so the fork's glossary wins.
// Keys with no translation to inherit get the English text and are listed, so `i18n:check` passes
// and the list says what still needs translating.
//
// usage: node scripts/fork-i18n-sync.ts [--check]   (--check writes nothing and fails on drift)
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const GENERATE: Record<string, readonly [string, ...string[]]> = {
  "apps/web": ["node_modules/.bin/gt", "generate"],
  "apps/mobile": ["node_modules/.bin/gt", "generate"],
  "apps/desktop": [process.execPath, "scripts/i18n-generate.mjs"],
};
const OVERRIDES = "packages/client-runtime/src/i18n/gt-zh-overrides.json";

// Old upstream wording -> the fork's. Applied to source text to match keys, and to translations.
const REWORDING: ReadonlyArray<readonly [RegExp, string]> = [
  [/T3 Code/gu, "T3 Extend"],
  [/`t3`/gu, "`t3x`"],
  [/`t3 /gu, "`t3x "],
  [/\bt3 (pair|serve|update|service)\b/gu, "t3x $1"],
];

type Catalog = Record<string, unknown>;
interface Overrides {
  /** Upstream zh term -> the fork's, replaced inside every zh value. */
  readonly terms: Readonly<Record<string, string>>;
  /** English source -> the fork's whole zh translation. */
  readonly messages: Readonly<Record<string, string>>;
}

const root = NodePath.resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const readJson = (file: string) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const mapStrings = (value: unknown, fn: (text: string) => string): unknown =>
  typeof value === "string"
    ? fn(value)
    : Array.isArray(value)
      ? value.map((item) => mapStrings(item, fn))
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]))
        : value;
const reword = (text: string) =>
  REWORDING.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
// The fork's wording mapped back to upstream's, so a reworded source finds its old key.
const unword = (text: string) =>
  text
    .replace(/T3 Extend/gu, "T3 Code")
    .replace(/`t3x`/gu, "`t3`")
    .replace(/`t3x /gu, "`t3 ")
    .replace(/\bt3x (pair|serve|update|service)\b/gu, "t3 $1");
const textOf = (value: unknown) => JSON.stringify(value);

const overrides: Overrides = readJson(NodePath.join(root, OVERRIDES));
const termEntries = Object.entries(overrides.terms).sort(([a], [b]) => b.length - a.length);
const applyTerms = (text: string) =>
  termEntries.reduce((result, [from, to]) => result.split(from).join(to), text);

const untranslated: string[] = [];
let drift = false;

for (const [app, [command, ...args]] of Object.entries(GENERATE)) {
  const appDir = NodePath.join(root, app);
  const config = readJson(NodePath.join(appDir, "gt.config.json"));
  const catalogDir = NodePath.join(appDir, NodePath.dirname(config.files.gt.output));
  const catalogPath = (locale: string) => NodePath.join(catalogDir, `${locale}.json`);
  const oldSource: Catalog = readJson(catalogPath(config.defaultLocale));

  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-i18n-sync-"));
  let source: Catalog;
  try {
    const tmpConfig = NodePath.join(tmp, "gt.config.json");
    NodeFS.writeFileSync(
      tmpConfig,
      JSON.stringify({ ...config, locales: [], files: { gt: { output: `${tmp}/[locale].json` } } }),
    );
    const gt = NodeChildProcess.spawnSync(command, [...args, "--config", tmpConfig], {
      cwd: appDir,
      encoding: "utf8",
    });
    if (gt.status !== 0) throw new Error(`${app}: gt generate failed\n${gt.stdout}${gt.stderr}`);
    source = readJson(NodePath.join(tmp, `${config.defaultLocale}.json`));
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }

  const oldKeysByText = new Map<string, string>();
  for (const [key, value] of Object.entries(oldSource)) {
    const text = textOf(mapStrings(value, unword));
    if (!oldKeysByText.has(text)) oldKeysByText.set(text, key);
  }
  const inheritedFrom = (key: string, value: unknown): string | undefined =>
    Object.hasOwn(oldSource, key) ? key : oldKeysByText.get(textOf(mapStrings(value, unword)));

  const write = (file: string, catalog: Catalog) => {
    const next = `${JSON.stringify(catalog, null, 2)}\n`;
    const current = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
    if (next === current) return;
    drift = true;
    if (!check) NodeFS.writeFileSync(file, next);
  };
  write(catalogPath(config.defaultLocale), source);

  for (const locale of config.locales as string[]) {
    const old: Catalog = readJson(catalogPath(locale));
    const next: Catalog = {};
    for (const [key, value] of Object.entries(source)) {
      const from = inheritedFrom(key, value);
      let translated: unknown =
        from === undefined || !Object.hasOwn(old, from)
          ? undefined
          : // Only a reworded key's translation is reworded; an unchanged one may name the official app.
            from === key
            ? old[from]
            : mapStrings(old[from], reword);
      if (locale === "zh") {
        const english = typeof value === "string" ? overrides.messages[value] : undefined;
        if (english !== undefined) translated = english;
        else if (translated !== undefined) translated = mapStrings(translated, applyTerms);
      }
      if (translated === undefined) {
        translated = value;
        if (locale === "zh") untranslated.push(`${app}: ${key} ${textOf(value)}`);
      }
      next[key] = translated;
    }
    write(catalogPath(locale), next);
  }
}

if (untranslated.length > 0) {
  console.log(`zh has no translation for ${untranslated.length} key(s); English shows for now:`);
  console.log(untranslated.map((line) => `  ${line}`).join("\n"));
  console.log(`Add them to "messages" in ${OVERRIDES}, then run this again.`);
}
if (check && drift) {
  console.error(
    "GT catalogs are out of step with the source. Run `node scripts/fork-i18n-sync.ts`.",
  );
  process.exitCode = 1;
}
