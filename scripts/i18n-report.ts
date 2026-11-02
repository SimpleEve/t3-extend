// @effect-diagnostics nodeBuiltinImport:off - a plain file scan; it must run without the app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseAst } from "vite-plus";

// fork: lists English sources that call sites translate but a catalog lacks, catalog keys whose
// English source no longer appears in code (usually because upstream reworded it), and English
// JSX text that never reaches t(). It only reports and always exits 0; see FORK.md "多语言".

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
  // fork: the T3 tool summaries in client-runtime pass both forms of a phrase to a helper.
  new RegExp(String.raw`\bphrase\(\s*` + QUOTED, "g"),
  new RegExp(String.raw`\bphrase\(\s*"[^"]*"\s*,\s*` + QUOTED, "g"),
  new RegExp(String.raw`\bquantity\(\s*[^,]+,\s*` + QUOTED, "g"),
  new RegExp(String.raw`\bquantity\(\s*[^,]+,\s*"[^"]*"\s*,\s*` + QUOTED, "g"),
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

// fork: the "hard-coded" section finds English JSX that bypasses t(). The two allowlists below are
// the only way an entry leaves the report, so a new one needs a reason a reviewer can check.
const HARD_CODED_ROOTS = ["apps/web/src", "apps/mobile/src"];

const TEXT_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "aside",
  "description",
  "detail",
  "details",
  "heading",
  "hint",
  "label",
  "message",
  "placeholder",
  "subtitle",
  "text",
  "title",
  "tooltip",
]);
const TEXT_ATTRIBUTE_SUFFIX = /(?:Description|Hint|Label|Message|Placeholder|Reason|Text|Title)$/u;

const ENGLISH_WORD = /[A-Za-z]{2,}/u;

// Contents of these elements are code or key names, not sentences.
const CODE_ELEMENTS = new Set(["code", "kbd", "pre", "samp", "style"]);

// (a) Text that stays English in every language: products, formats, units, commands, sample input.
const ALWAYS_ENGLISH_TEXT = new Set([
  // Products and platforms.
  "Android",
  "Code", // The second half of the T3 Code wordmark.
  "Codex",
  "Cursor",
  "iOS",
  "Simlock",
  "Whoosh", // A sound name.
  "ghost", // GitHub's login for a deleted account.
  "t3.chat",
  "T3 Chat",
  "T3 Code",
  "T3 Connect",
  "T3 Extend",
  // Formats, units, and key names.
  "Aa",
  "Alt",
  "Backspace",
  "CPU",
  "Ctrl",
  "Enter",
  "Esc",
  "HEX",
  "HTTPS",
  "INT",
  "KILL",
  "PDF",
  "PID",
  "RGB",
  "SSH",
  "ab", // The match-whole-word toggle's glyph, beside "Aa".
  "base64",
  "fps",
  "hex",
  "ms",
  "px",
  "vs",
  // Commands, code, and sample input in placeholders.
  "/skill:",
  "Mac mini",
  "PAIRCODE",
  "body.action",
  "bun test",
  "frpc -c ~/frpc.toml",
  "git clone",
  "localhost:",
  "model-slug",
  "npx t3 pair --tailscale",
  "npx t3 serve",
  "opened",
  "opened, reopened",
  "optionId",
  "origin",
  "root",
  "simlock --gateway token create --role agent",
  "t3 auth pairing create",
  "value",
]);
const ALWAYS_ENGLISH_PATTERNS: ReadonlyArray<RegExp> = [
  /^https?:\/\//u, // Sample URLs, some with ${} parts.
  /^[\w.-]+\.(?:com|net)$/u, // Sample hostnames.
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u, // Environment variable names.
  /^\{\{[\w.-]+\}\}$/u, // Webhook template samples.
  /^\{ "version"/u, // The theme file sample.
  /^\$\{…\}_work$/u, // Sample provider instance name.
  /^[~/][\w./-]+$/u, // File paths.
];

// (b) `Component.prop` pairs whose component passes the prop through t() itself. Add a pair only
// after reading the component.
// A name that several files define locally is scoped as `File.tsx#Component.prop`. Web only:
// mobile has its own components with some of the same names.
const SELF_TRANSLATING_PROPS = new Set([
  "DeviceToolsPanel.tsx#ChoiceSelect.ariaLabel",
  "DeviceToolsPanel.tsx#ChoiceSelect.placeholder",
  "DeviceToolsPanel.tsx#Row.label",
  "DeviceToolsPanel.tsx#Section.title",
  "DeviceToolsPanel.tsx#SubmitRow.placeholder",
  "DeviceToolsPanel.tsx#SwitchRow.label",
  "SettingsSection.title",
  "SettingsRow.title",
  "SettingResetButton.label",
  "SettingResetButton.tooltip",
  "SidebarSectionHeader.label",
  "SidebarDragBoundary.label",
  "SidebarSectionPlaceholder.label",
  "MessageCopyButton.label",
  "SpeedSegment.label",
  "composerContextPresentation.tsx#ContextChip.kindLabel",
]);

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly [key: string]: unknown;
}

export interface HardCodedHit {
  readonly line: number;
  readonly kind: string;
  readonly text: string;
}

export interface HardCodedScan {
  readonly hits: ReadonlyArray<HardCodedHit>;
  /** Literals handed to a self-translating prop; the catalog must still hold them. */
  readonly selfTranslated: ReadonlyArray<string>;
}

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";

const isTextAttribute = (name: string) =>
  TEXT_ATTRIBUTES.has(name) || TEXT_ATTRIBUTE_SUFFIX.test(name);

const needsTranslation = (text: string) =>
  ENGLISH_WORD.test(text) &&
  !ALWAYS_ENGLISH_TEXT.has(text) &&
  !ALWAYS_ENGLISH_PATTERNS.some((pattern) => pattern.test(text));

function elementName(name: AstNode): string {
  if (name.type === "JSXMemberExpression") {
    return `${elementName(name.object as AstNode)}.${elementName(name.property as AstNode)}`;
  }
  return String(name.name);
}

interface DisplayString {
  readonly start: number;
  readonly text: string;
  readonly interpolated: boolean;
}

// The display strings an expression can evaluate to. A call such as t("...") yields nothing.
function displayStrings(expression: AstNode): ReadonlyArray<DisplayString> {
  switch (expression.type) {
    case "Literal":
      return typeof expression.value === "string"
        ? [{ start: expression.start, text: expression.value, interpolated: false }]
        : [];
    case "TemplateLiteral": {
      const quasis = (expression.quasis as ReadonlyArray<{ value: { cooked: string } }>).map(
        (quasi) => quasi.value.cooked,
      );
      return quasis.some((quasi) => ENGLISH_WORD.test(quasi))
        ? [{ start: expression.start, text: quasis.join("${…}"), interpolated: quasis.length > 1 }]
        : [];
    }
    case "ConditionalExpression":
      return [expression.consequent, expression.alternate].flatMap((branch) =>
        displayStrings(branch as AstNode),
      );
    case "LogicalExpression":
      return [expression.left, expression.right].flatMap((branch) =>
        displayStrings(branch as AstNode),
      );
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return displayStrings(expression.expression as AstNode);
    default:
      return [];
  }
}

export function scanHardCodedText(code: string, fileName = ""): HardCodedScan {
  const hits: HardCodedHit[] = [];
  const selfTranslated: string[] = [];
  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length;
  const report = (start: number, kind: string, raw: string) => {
    // JSXText keeps entities such as &middot; raw; they are not words.
    const text = raw.replace(/&\w+;/gu, " ").replace(/\s+/gu, " ").trim();
    if (needsTranslation(text)) hits.push({ line: lineOf(start), kind, text });
  };

  const scanChildren = (element: AstNode, children: ReadonlyArray<AstNode>) => {
    const opening = element.openingElement as AstNode | undefined;
    const name = opening ? elementName(opening.name as AstNode) : "";
    if (CODE_ELEMENTS.has(name)) return;
    for (const child of children) {
      if (child.type === "JSXText") {
        report(child.start, "text", String(child.value));
      } else if (child.type === "JSXExpressionContainer") {
        for (const { start, text } of displayStrings(child.expression as AstNode)) {
          report(start, "child", text);
        }
      }
    }
  };

  const scanAttributes = (opening: AstNode) => {
    const element = elementName(opening.name as AstNode);
    for (const attribute of opening.attributes as ReadonlyArray<AstNode>) {
      if (attribute.type !== "JSXAttribute") continue;
      const nameNode = attribute.name as AstNode;
      if (nameNode.type !== "JSXIdentifier") continue;
      const name = String(nameNode.name);
      if (!isTextAttribute(name)) continue;
      const value = attribute.value as AstNode | null;
      if (value === null) continue;
      const expression =
        value.type === "JSXExpressionContainer" ? (value.expression as AstNode) : value;
      const prop = `${element}.${name}`;
      const translatesItself =
        fileName.startsWith("apps/web/") &&
        (SELF_TRANSLATING_PROPS.has(prop) ||
          SELF_TRANSLATING_PROPS.has(`${NodePath.basename(fileName)}#${prop}`));
      for (const { start, text, interpolated } of displayStrings(expression)) {
        // An interpolated value can never match a catalog key, so t() inside the component misses it.
        if (translatesItself && !interpolated) {
          if (needsTranslation(text)) selfTranslated.push(text);
        } else {
          report(start, name, text);
        }
      }
    }
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      scanChildren(node, node.children as ReadonlyArray<AstNode>);
    } else if (node.type === "JSXOpeningElement") {
      scanAttributes(node);
    }
    Object.values(node).forEach(walk);
  };
  walk(parseAst(code, { lang: "tsx" }));
  return { hits: hits.toSorted((left, right) => left.line - right.line), selfTranslated };
}

function hardCodedSection(called: Map<string, string>): {
  readonly lines: ReadonlyArray<string>;
  readonly total: number;
} {
  const lines: string[] = [];
  let total = 0;
  const totals: string[] = [];
  for (const root of HARD_CODED_ROOTS) {
    let rootTotal = 0;
    const files = NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /(?<!\.test)\.tsx$/u.test(entry.name))
      .map((entry) => NodePath.join(entry.parentPath, entry.name))
      .toSorted();
    for (const file of files) {
      const { hits, selfTranslated } = scanHardCodedText(NodeFS.readFileSync(file, "utf8"), file);
      for (const source of selfTranslated) {
        if (!called.has(source)) called.set(source, file);
      }
      if (hits.length === 0) continue;
      rootTotal += hits.length;
      lines.push("", `  ${file} (${hits.length})`);
      for (const { line, kind, text } of hits) lines.push(`    ${file}:${line} [${kind}] ${text}`);
    }
    total += rootTotal;
    totals.push(`${root}: ${rootTotal}`);
  }
  return {
    lines: [
      "",
      `hard-coded (${total}): English JSX that bypasses t(); allowlists are in scripts/i18n-report.ts`,
      ...lines,
      "",
      `  hard-coded total ${total} (${totals.join(", ")})`,
    ],
    total,
  };
}

function main(): void {
  const roots = [
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

  const called = new Map<string, string>();
  const literals = new Set<string>();
  const templates: RegExp[] = [];
  for (const file of roots.flatMap(sourceFiles)) {
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

  const hardCoded = hardCodedSection(called);
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
  lines.push(
    ...hardCoded.lines,
    "",
    `i18n report: ${missingTotal} missing, ${staleTotal} stale, ${hardCoded.total} hard-coded (report only)`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (import.meta.main) main();
