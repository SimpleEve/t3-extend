// @effect-diagnostics nodeBuiltinImport:off - a plain file scan; it must run without the app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// fork: lists English sources that call sites translate but a catalog lacks, and catalog keys
// whose English source no longer appears in code (usually because upstream reworded it).
// It only reports and always exits 0; see FORK.md "多语言".

const ROOTS = [
  "apps/web/src",
  "apps/desktop/src",
  "apps/mobile/src", // fork: mobile calls t() since the new browser tab panel
  "packages/client-runtime/src",
  "packages/shared/src", // fork: tool labels in shared take a translator
  "packages/contracts/src", // fork: fixed labels from contracts are translated where shown
  // fork: provider and source control packages annotate settings fields and install hints the web shows.
  ...NodeFS.readdirSync("packages")
    .filter((name) => /^(provider|source-control)-/u.test(name))
    .map((name) => `packages/${name}/src`),
  "apps/server/src/sourceControl", // fork: git and jj install hints
];
const CATALOG_ROOT = "packages/client-runtime/src/i18n/catalogs";
// Mirrors CONTEXT_SEPARATOR in packages/client-runtime/src/i18n/translate.ts.
const CONTEXT_SEPARATOR = "|";

const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
// fork: t('…') and t(`…`) carry sources too; a template counts only without `${}` interpolation.
const QUOTED = String.raw`(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|\`((?:[^\`\\$]|\\.|\$(?!\{))*)\`)`;
// Call shapes whose first string argument is an English source.
const CALL_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(String.raw`\bt\(\s*` + QUOTED, "g"),
  new RegExp(String.raw`\btranslate\(\s*[\w.]+(?:\(\))?\s*,\s*` + QUOTED, "g"),
  new RegExp(String.raw`\blabel\(\s*` + QUOTED, "g"),
  new RegExp(String.raw`\brole\(\s*"[\w]+"\s*,\s*` + QUOTED, "g"),
  new RegExp(String.raw`<Translated\s+source=` + STRING, "g"),
];
const ANY_STRING = new RegExp(STRING, "g");
// fork: a template with `${}` matches the catalog key it renders to, interpolations as wildcards.
const INTERPOLATED_TEMPLATE = /`((?:[^`\\$]|\\.|\$(?!\{))*\$\{(?:[^`\\]|\\.)*)`/g;

function sourceFilesIn(dir: string): string[] {
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !/\.(ts|tsx)$/u.test(entry.name)) return [];
    if (/\.(test|browser\.test|stories)\.tsx?$/u.test(entry.name)) return [];
    return [NodePath.join(entry.parentPath, entry.name)];
  });
}

function sourceFiles(dir: string): string[] {
  return sourceFilesIn(dir).filter(
    (path) => !path.includes(`${NodePath.sep}catalogs${NodePath.sep}`),
  );
}

function unescape(literal: string): string {
  try {
    return JSON.parse(`"${literal}"`) as string;
  } catch {
    return literal;
  }
}

// fork: the source from whichever QUOTED alternative matched, as a double-quoted body for unescape.
function quotedSource(match: RegExpMatchArray): string {
  if (match[1] !== undefined) return unescape(match[1]);
  const body = match[2] ?? match[3]!;
  return unescape(
    body.replace(/\\(.)|"|\n/gs, (whole, escaped: string | undefined) => {
      if (escaped !== undefined) return "'`$".includes(escaped) ? escaped : whole;
      return whole === '"' ? '\\"' : "\\n";
    }),
  );
}

// Catalog files are flat object literals; each entry's key starts its own line.
const CATALOG_KEY = new RegExp(
  String.raw`^\s*(?:` + QUOTED + String.raw`|([A-Za-z_$][\w$]*))\s*:`,
  "gm",
);

function catalogKeys(locale: string): ReadonlyArray<string> {
  return sourceFilesIn(NodePath.join(CATALOG_ROOT, locale)).flatMap((file) =>
    [...NodeFS.readFileSync(file, "utf8").matchAll(CATALOG_KEY)].map((match) =>
      match[4] === undefined ? quotedSource(match) : match[4],
    ),
  );
}

const called = new Map<string, string>();
const literals = new Set<string>();
const templates: RegExp[] = [];
for (const file of ROOTS.flatMap(sourceFiles)) {
  const text = NodeFS.readFileSync(file, "utf8");
  for (const match of text.matchAll(ANY_STRING)) literals.add(unescape(match[1]!));
  // JSX attribute strings are not JS string literals, but carry English sources too.
  for (const match of text.matchAll(/=\s*"([^"\n]*)"/g)) literals.add(match[1]!);
  for (const match of text.matchAll(INTERPOLATED_TEMPLATE)) {
    const parts = match[1]!.replace(/\\(.)/gs, "$1").split(/\$\{[^}]*\}/u);
    const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    templates.push(new RegExp(`^${escaped.join(".+")}$`, "su"));
  }
  for (const pattern of CALL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const source = quotedSource(match);
      // A called source is in code even when quote pairing above went off track.
      literals.add(source);
      if (!called.has(source)) called.set(source, NodePath.relative(process.cwd(), file));
    }
  }
}

// fork: keybinding labels are derived from command ids (commandLabel in
// apps/web/src/components/settings/KeybindingsSettings.logic.ts), so count those as in code.
const titleCase = (segment: string) =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
for (const match of NodeFS.readFileSync("packages/contracts/src/keybindings.ts", "utf8").matchAll(
  /"([a-z][A-Za-z]*(?:\.[A-Za-z0-9]+)+)"/g,
)) {
  literals.add(match[1]!.split(".").map(titleCase).join(": "));
}

const lines: string[] = [];
let missingTotal = 0;
let staleTotal = 0;
for (const locale of NodeFS.readdirSync(CATALOG_ROOT)) {
  const keys = catalogKeys(locale);
  const sources = new Set(
    keys.map((key) => {
      const separator = key.indexOf(CONTEXT_SEPARATOR);
      return separator < 0 ? key : key.slice(separator + 1);
    }),
  );
  const missing = [...called].filter(([source]) => !sources.has(source));
  const stale = keys.filter((key) => {
    const separator = key.indexOf(CONTEXT_SEPARATOR);
    const source = separator < 0 ? key : key.slice(separator + 1);
    return !literals.has(source) && !templates.some((template) => template.test(source));
  });
  missingTotal += missing.length;
  staleTotal += stale.length;
  lines.push(
    "",
    `[${locale}] ${keys.length} entries, ${called.size} sources called`,
    `  missing (${missing.length}): translated at a call site, absent from the catalog`,
    ...missing.map(([source, file]) => `    ${JSON.stringify(source)}  ${file}`),
    `  stale (${stale.length}): in the catalog, no longer anywhere in code`,
    ...stale.map((key) => `    ${JSON.stringify(key)}`),
  );
}
lines.push("", `i18n report: ${missingTotal} missing, ${staleTotal} stale (report only)`);
process.stdout.write(`${lines.join("\n")}\n`);
