// @effect-diagnostics nodeBuiltinImport:off - a plain file scan; it must run without the app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// fork: lists English sources that call sites translate but a catalog lacks, and catalog keys
// whose English source no longer appears in code (usually because upstream reworded it).
// It only reports and always exits 0; see FORK.md "多语言".

const ROOTS = [
  "apps/web/src",
  "apps/desktop/src",
  "apps/mobile/src",
  "packages/client-runtime/src",
];
const CATALOG_ROOT = "packages/client-runtime/src/i18n/catalogs";
// Mirrors CONTEXT_SEPARATOR in packages/client-runtime/src/i18n/translate.ts.
const CONTEXT_SEPARATOR = "|";

const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
// Call shapes whose first string argument is an English source.
const CALL_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(String.raw`\bt\(\s*` + STRING, "g"),
  new RegExp(String.raw`\btranslate\(\s*[\w.]+(?:\(\))?\s*,\s*` + STRING, "g"),
  new RegExp(String.raw`\blabel\(\s*` + STRING, "g"),
  new RegExp(String.raw`\brole\(\s*"[\w]+"\s*,\s*` + STRING, "g"),
  new RegExp(String.raw`<Translated\s+source=` + STRING, "g"),
];
const ANY_STRING = new RegExp(STRING, "g");

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

// Catalog files are flat object literals; each entry's key starts its own line.
const CATALOG_KEY = new RegExp(
  String.raw`^\s*(?:` + STRING + String.raw`|([A-Za-z_$][\w$]*))\s*:`,
  "gm",
);

function catalogKeys(locale: string): ReadonlyArray<string> {
  return sourceFilesIn(NodePath.join(CATALOG_ROOT, locale)).flatMap((file) =>
    [...NodeFS.readFileSync(file, "utf8").matchAll(CATALOG_KEY)].map((match) =>
      match[1] === undefined ? match[2]! : unescape(match[1]),
    ),
  );
}

const called = new Map<string, string>();
const literals = new Set<string>();
for (const file of ROOTS.flatMap(sourceFiles)) {
  const text = NodeFS.readFileSync(file, "utf8");
  for (const match of text.matchAll(ANY_STRING)) literals.add(unescape(match[1]!));
  // JSX attribute strings are not JS string literals, but carry English sources too.
  for (const match of text.matchAll(/=\s*"([^"\n]*)"/g)) literals.add(match[1]!);
  for (const pattern of CALL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const source = unescape(match[1]!);
      if (!called.has(source)) called.set(source, NodePath.relative(process.cwd(), file));
    }
  }
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
    return !literals.has(separator < 0 ? key : key.slice(separator + 1));
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
