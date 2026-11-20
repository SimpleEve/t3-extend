// @effect-diagnostics nodeBuiltinImport:off - a plain file scan; it must run without the app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseAst } from "vite-plus";

// fork: lists English sources that call sites translate but a catalog lacks, catalog keys whose
// English source no longer appears in code (usually because upstream reworded it), English
// JSX text and object-literal copy that never reach t(), and comparisons against translated
// sources. It only reports and always exits 0; see FORK.md "多语言".

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
// fork: any file that can hand text to a translator.
const TRANSLATOR_USE = /\btranslatorFor\(|\bt\(|\btranslate\(|<Translated\b/u;
const FIXED_WORD = /[A-Za-z]{3,}/u;
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

/** The English source of a catalog key. A context is lowercase words, so "a || b" keeps its bar. */
export function catalogKeySource(key: string): string {
  const separator = key.indexOf(CONTEXT_SEPARATOR);
  return separator > 0 && /^[a-z][a-z0-9 -]*$/u.test(key.slice(0, separator))
    ? key.slice(separator + 1)
    : key;
}

function catalogKeys(locale: string): ReadonlyArray<string> {
  return sourceFilesIn(NodePath.join(CATALOG_ROOT, locale)).flatMap((file) =>
    [...NodeFS.readFileSync(file, "utf8").matchAll(CATALOG_KEY)].map((match) =>
      match[4] === undefined ? quotedSource(match) : match[4],
    ),
  );
}

// fork: sources that reach t() on purpose and stay English in every language, so they are not
// missing. Upstream passes whole label tables through t(); only these entries are names.
const INTENTIONALLY_UNTRANSLATED = new Set([
  // Search engines.
  "Bing",
  "Brave Search",
  "DuckDuckGo",
  "Ecosia",
  "Google",
  "Kagi",
  // Products and providers.
  "Claude Code",
  "Codex",
  "Pi",
  "T3 Code",
  "Tailscale HTTPS",
  // Text generator services, shown with their brand names.
  "OpenAI",
  "OpenRouter",
  "Anthropic",
  // A named convention.
  "Conventional Commits",
  // A language's name is written in that language.
  "English",
]);

const parsedPrograms = new Map<string, unknown>();
// One parse per file in a report run: the missing check and every section walk the same trees.
function parseSource(file: string, code: string): unknown {
  let program = parsedPrograms.get(file);
  if (program === undefined) {
    program = parseAst(code, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
    parsedPrograms.set(file, program);
  }
  return program;
}

export interface IndirectSource {
  readonly line: number;
  readonly source: string;
}

const unwrapExpression = (node: unknown): AstNode | null => {
  if (!isAstNode(node)) return null;
  return node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ParenthesizedExpression"
    ? unwrapExpression(node.expression)
    : node;
};

const literalString = (node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null) return null;
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  if (
    expression.type === "TemplateLiteral" &&
    (expression.expressions as ReadonlyArray<unknown>).length === 0
  ) {
    return (expression.quasis as ReadonlyArray<{ value: { cooked: string } }>)[0]!.value.cooked;
  }
  return null;
};

// The strings an access path reaches inside a literal; "*" stands for any key or element.
function stringsAt(node: unknown, path: ReadonlyArray<string>): ReadonlyArray<string> {
  const expression = unwrapExpression(node);
  if (expression === null) return [];
  if (path.length === 0) {
    const value = literalString(expression);
    return value === null ? [] : [value];
  }
  const [step, ...rest] = path;
  if (expression.type === "ObjectExpression") {
    return (expression.properties as ReadonlyArray<AstNode>).flatMap((property) => {
      if (property.type !== "Property") return [];
      const key = property.key as AstNode;
      const name =
        key.type === "Identifier" && property.computed !== true
          ? String(key.name)
          : literalString(key);
      return step === "*" || name === step ? stringsAt(property.value, rest) : [];
    });
  }
  if (expression.type === "ArrayExpression" && step === "*") {
    return (expression.elements as ReadonlyArray<unknown>).flatMap((element) =>
      stringsAt(element, rest),
    );
  }
  return [];
}

/**
 * Sources that the call patterns above cannot see: `translatorFor(locale)("…")`, and a module
 * constant read through `t(CONST[key])`, `t(CONST.prop)`, or `t(CONST[key].prop)`, which may
 * reach any of the constant's matching strings.
 */
export function scanIndirectSources(
  code: string,
  fileName: string,
  program: unknown = parseAst(code, { lang: fileName.endsWith(".tsx") ? "tsx" : "ts" }),
): ReadonlyArray<IndirectSource> {
  const sources: IndirectSource[] = [];
  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length;
  const constants = new Map<string, unknown>();
  for (const statement of (program as { body: ReadonlyArray<AstNode> }).body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? (statement.declaration as AstNode) : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations as ReadonlyArray<AstNode>) {
      const id = declarator.id as AstNode;
      if (id.type === "Identifier" && declarator.init)
        constants.set(String(id.name), declarator.init);
    }
  }

  const sourcesOf = (argument: unknown): ReadonlyArray<string> => {
    const direct = literalString(argument);
    if (direct !== null) return [direct];
    // fork: `t(cond ? "A" : "B")` reaches both branches.
    const conditional = unwrapExpression(argument);
    if (conditional?.type === "ConditionalExpression") {
      return [conditional.consequent, conditional.alternate].flatMap(sourcesOf);
    }
    const path: string[] = [];
    let target = unwrapExpression(argument);
    while (target?.type === "MemberExpression") {
      const property = target.property as AstNode;
      path.unshift(target.computed === true ? "*" : String(property.name));
      target = unwrapExpression(target.object);
    }
    if (target?.type !== "Identifier" || path.length === 0) return [];
    const constant = constants.get(String(target.name));
    return constant === undefined ? [] : stringsAt(constant, path);
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      const [first, second] = node.arguments as ReadonlyArray<unknown>;
      const curried =
        callee.type === "CallExpression" &&
        (callee.callee as AstNode).type === "Identifier" &&
        (callee.callee as AstNode).name === "translatorFor";
      const named = callee.type === "Identifier" ? String(callee.name) : null;
      let found: ReadonlyArray<string> = [];
      if (curried) found = sourcesOf(first);
      // Direct literals in t() and translate() are the regex patterns' job.
      else if (named === "t" && literalString(first) === null) found = sourcesOf(first);
      else if (named === "translate" && literalString(second) === null) found = sourcesOf(second);
      for (const source of found) {
        if (ENGLISH_WORD.test(source)) sources.push({ line: lineOf(node.start), source });
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(program);
  return sources;
}

// fork: tables whose listed properties reach t() through a variable, so no call site carries the
// literal. `SettingsRow` and `SettingsSection` run `t(title)` on titles that arrive from
// `searchableSetting(id)`; the report cannot follow that, so these literals count as called.
const TRANSLATED_PROPERTY_TABLES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["apps/web/src/components/settings/settingsSearch.ts", new Set(["title"])],
  // `t(outcome)` and `t(THREAD_STATUS_TEXT[key])` read these through a variable.
  [
    "packages/client-runtime/src/state/threadActivityAnnouncement.ts",
    new Set(["working", "approval", "input", "done", "failed", "stopped"]),
  ],
]);

/** String literals in the named properties of every object literal in a table file. */
export function scanTranslatedTable(
  code: string,
  fileName: string,
  properties: ReadonlySet<string>,
  program: unknown = parseAst(code, { lang: fileName.endsWith(".tsx") ? "tsx" : "ts" }),
): ReadonlyArray<IndirectSource> {
  const sources: IndirectSource[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "Property" && node.computed !== true) {
      const name = propertyName(node);
      const source = name !== null && properties.has(name) ? literalString(node.value) : null;
      if (source !== null && ENGLISH_WORD.test(source)) {
        sources.push({ line: code.slice(0, node.start).split("\n").length, source });
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(program);
  return sources;
}

export interface CallKey {
  readonly source: string;
  /** A literal context, null when the call passes none, undefined when it is not a literal. */
  readonly context: string | null | undefined;
}

/**
 * Direct `t(source, params, context)` and `translate(locale, source, params, context)` calls with
 * their literal context. The catalog holds a contextual entry under `context|source`, so a call
 * without that context does not reach it, whatever the bare source is called elsewhere.
 */
export function scanCallKeys(
  code: string,
  fileName: string,
  program: unknown = parseAst(code, { lang: fileName.endsWith(".tsx") ? "tsx" : "ts" }),
): ReadonlyArray<CallKey> {
  const keys: CallKey[] = [];
  const literalSources = (argument: unknown): ReadonlyArray<string> => {
    const direct = literalString(argument);
    if (direct !== null) return [direct];
    const expression = unwrapExpression(argument);
    return expression?.type === "ConditionalExpression"
      ? [expression.consequent, expression.alternate].flatMap(literalSources)
      : [];
  };
  const contextOf = (argument: unknown): string | null | undefined => {
    if (argument === undefined) return null;
    const literal = literalString(argument);
    if (literal !== null) return literal;
    const expression = unwrapExpression(argument);
    return expression?.type === "Identifier" && expression.name === "undefined" ? null : undefined;
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      const args = node.arguments as ReadonlyArray<unknown>;
      const name = callee.type === "Identifier" ? String(callee.name) : null;
      const offset = name === "t" ? 0 : name === "translate" ? 1 : null;
      if (offset !== null && args.length > offset) {
        for (const source of literalSources(args[offset])) {
          if (ENGLISH_WORD.test(source)) {
            keys.push({ source, context: contextOf(args[offset + 2]) });
          }
        }
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(program);
  return keys;
}

/** The catalog key a call must find: `context|source`, or the bare source without a context. */
export function callCatalogKey({ source, context }: CallKey): string | null {
  return context === undefined
    ? null
    : context === null
      ? source
      : `${context}${CONTEXT_SEPARATOR}${source}`;
}

/** A template's text as a pattern for the sources it can render; null when it would match any text. */
export function templateSourcePattern(template: string): RegExp | null {
  const parts = template.replace(/\\(.)/gs, "$1").split(/\$\{[^}]*\}/u);
  // Fixed text with no word (`${a}, ${b}`) matches every sentence, so no key could go stale.
  if (!parts.some((part) => FIXED_WORD.test(part))) return null;
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".+")}$`, "su");
}

// fork: the "hard-coded" section finds English JSX that bypasses t(). The two allowlists below are
// the only way an entry leaves the report, so a new one needs a reason a reviewer can check.
const HARD_CODED_ROOTS = ["apps/web/src", "apps/mobile/src"];
// The development catalog and its samples are a tool for building mobile, never shipped copy.
const HARD_CODED_EXCLUDED_DIRS = ["apps/mobile/src/features/development/"];

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
  "MB", // A unit, in front of a number.
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
  "Tailscale HTTPS",
  "One UI", // Samsung's skin: the name of a navigation style, not a sentence.
  "Material", // Google's design system, named the same way.
  "Material You",
  "CarPlay",
  // Formats, units, and key names.
  "Aa",
  "Alt",
  "Backspace",
  "CPU",
  "Ctrl",
  "Ctrl-C", // The terminal key's name on the mobile key bar.
  "Enter",
  "Esc",
  "HEX",
  "HTML",
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

// (b) `Component.prop` pairs whose component passes the prop through t() itself. Read the component
// first. A name several files define is scoped as `File.tsx#Component.prop`; the bare form is web
// only, because mobile has same-named components, so mobile entries need the file-scoped form.
const SELF_TRANSLATING_PROPS = new Set([
  "DeviceToolsPanel.tsx#ChoiceSelect.ariaLabel",
  "DeviceToolsPanel.tsx#ChoiceSelect.placeholder",
  "DeviceToolsPanel.tsx#Row.label",
  "DeviceToolsPanel.tsx#Section.title",
  "DeviceToolsPanel.tsx#SubmitRow.placeholder",
  "DeviceToolsPanel.tsx#SwitchRow.label",
  "SettingsSection.title",
  "SettingsRow.title",
  "MarkdownFileLink.openInEditorMenuLabel", // translateOpenInLabel() keeps the editor name and translates the rest.
  "SettingResetButton.label",
  "SettingResetButton.tooltip",
  "SidebarSectionHeader.label",
  "SidebarDragBoundary.label",
  "SidebarSectionPlaceholder.label",
  "MessageCopyButton.label",
  "SpeedSegment.label",
  "composerContextPresentation.tsx#ContextChip.kindLabel",
  // Mobile: the field translates its own label (`t(props.label, undefined, "context field")`).
  "ComposerContextSheet.tsx#ContextField.label",
]);

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly [key: string]: unknown;
}

// `path#text` pairs in the hard-coded scan: sample content that previews a setting, not copy. Each
// needs a reason.
const JSX_TEXT_ALLOWLIST = new Set([
  // The font preview's pangram and the terminal and code previews show how typefaces and the
  // terminal palette look; real tools print English, so the sample stays English.
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#The quick brown fox jumps over the lazy dog.",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#t3code",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#git:(",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#main",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#vpr dev",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#VITE v7.1.1",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#ready in",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#Local:",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#✓ 85 passed",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#△ 2 warnings",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#✗ 0 failed",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#READY",
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#watching for changes",
  // The size unit beside a number: points are written pt in every language.
  "apps/mobile/src/features/settings/appearance/sections/CodeAppearanceSection.tsx#${…} pt",
  "apps/mobile/src/features/settings/appearance/sections/TerminalAppearanceSection.tsx#${…} pt",
  "apps/mobile/src/features/settings/appearance/sections/TextAppearanceSection.tsx#${…} pt",
  // The typed syntax of a slash command: `/skill:name`, as in the composer's popover.
  "apps/mobile/src/features/threads/ComposerCommandPopover.tsx#skill:",
  // Sample branch names in the input's placeholder, like the web's sample hostnames and paths.
  "apps/mobile/src/features/threads/git/GitBranchesSheet.tsx#feature/mobile-polish",
  "apps/mobile/src/features/threads/git/GitBranchesSheet.tsx#main",
  "apps/mobile/src/features/threads/git/GitBranchesSheet.tsx#feature/mobile-thread",
  // The fallback when the app sends no translated "as of" text; SubscriptionUsageCoordinator
  // sends `checkedAtLabel` in the interface language, so the fallback only shows for old snapshots.
  "apps/mobile/src/widgets/SubscriptionUsage.android.tsx#As of ${…}",
  "apps/mobile/src/widgets/SubscriptionUsage.tsx#As of ${…}",
]);

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
// fork: `constants` are the file's top-level string constants, so `{MESSAGE}` shows its text.
function displayStrings(
  expression: AstNode,
  constants?: ReadonlyMap<string, string>,
): ReadonlyArray<DisplayString> {
  switch (expression.type) {
    case "Identifier": {
      const text = constants?.get(String(expression.name));
      return text === undefined ? [] : [{ start: expression.start, text, interpolated: false }];
    }
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
        displayStrings(branch as AstNode, constants),
      );
    case "LogicalExpression":
      return [expression.left, expression.right].flatMap((branch) =>
        displayStrings(branch as AstNode, constants),
      );
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return displayStrings(expression.expression as AstNode, constants);
    default:
      return [];
  }
}

export function scanHardCodedText(
  code: string,
  fileName = "",
  program: unknown = parseAst(code, { lang: "tsx" }),
): HardCodedScan {
  const hits: HardCodedHit[] = [];
  const selfTranslated: string[] = [];
  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length;
  const constants = new Map<string, string>();
  for (const statement of (program as { body: ReadonlyArray<AstNode> }).body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? (statement.declaration as AstNode) : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations as ReadonlyArray<AstNode>) {
      const id = declarator.id as AstNode;
      const text = id.type === "Identifier" ? literalString(declarator.init) : null;
      if (text !== null) constants.set(String(id.name), text);
    }
  }
  const report = (start: number, kind: string, raw: string) => {
    // JSXText keeps entities such as &middot; raw; they are not words.
    const text = raw.replace(/&\w+;/gu, " ").replace(/\s+/gu, " ").trim();
    if (JSX_TEXT_ALLOWLIST.has(`${fileName}#${text}`)) return;
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
        for (const { start, text } of displayStrings(child.expression as AstNode, constants)) {
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
        (fileName.startsWith("apps/web/") && SELF_TRANSLATING_PROPS.has(prop)) ||
        SELF_TRANSLATING_PROPS.has(`${NodePath.basename(fileName)}#${prop}`);
      for (const { start, text, interpolated } of displayStrings(expression, constants)) {
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
  walk(program);
  return { hits: hits.toSorted((left, right) => left.line - right.line), selfTranslated };
}

// fork: the "hard-coded (properties)" section finds interface copy in object literals, such as
// menu items, toasts built in .ts helpers, and error messages, which the JSX scan cannot see.
const UI_PROPERTIES = new Set([
  "description",
  "detail",
  "heading",
  "hint",
  "label",
  "message",
  "placeholder",
  "summary",
  "text",
  "title",
  "tooltip",
]);
const UI_PROPERTY_SUFFIX = /(?:Label|Message|Text|Title)$/u;

// Options of these calls name an operation for logs and spans; nothing renders their label.
const OPERATION_LABEL_CALLS = new Set([
  "executeAtomQuery",
  "reportAtomCommandResult",
  "runAtomCommand",
  "useAtomCommand",
  "useAtomQueryRunner",
  "useOrchestrationCommand",
]);

// `path` skips a file, `path#property` one property in it. Each needs a reason a reviewer can check.
const PROPERTY_ALLOWLIST = new Set([
  // Preset and font names are data; the studio translates them where it draws them, and the catalog has each.
  "apps/web/src/fork/themeStudio/presets.ts#label", // fork: theme studio
  // Programming language and product names stay English.
  "apps/web/src/composer-code-languages.ts",
  "apps/web/src/components/usage/usageProviders.ts",
  // Sent to the server as the client's name in auth sessions.
  "apps/web/src/connection/clientMetadata.ts#label",
  // Thread titles and messages sent to the server: user content and model-facing text.
  "apps/web/src/components/chat/useComposerResume.ts#text",
  "apps/web/src/components/chat/useTimelineRewind.ts#title",
  // Review comment contexts are written into the prompt.
  "apps/web/src/components/pullRequest/pullRequestDetail.logic.ts#sectionTitle",
  "apps/web/src/components/pullRequest/PullRequestCodeTab.tsx#sectionTitle",
  "apps/web/src/reviewCommentContext.ts#rangeLabel",
  // English on purpose: the catalog that would translate this toast is the one that failed.
  "apps/web/src/uiLanguage.ts",
  // Error objects that are logged or cross a boundary keep English where they are made; the
  // display translates the known ones (connection/errorMessages.ts) or shows them as written.
  "apps/web/src/browser/openFileInPreview.ts#message",
  "apps/web/src/cloud/linkEnvironment.ts#message",
  "apps/web/src/components/ChatMarkdown.tsx#message",
  "apps/web/src/components/chat/citationProcedure.ts#message",
  "apps/web/src/components/guest/guestTurnItemSource.ts#message",
  "apps/web/src/components/settings/OpenSourceLicenses.tsx#message",
  "apps/web/src/components/settings/scopedSettings.ts#message",
  "apps/web/src/components/settings/useProjectScriptSettings.ts#message",
  "apps/web/src/components/settings/useScopedSettings.ts#message",
  "apps/web/src/connection/platform.ts#detail",
  "apps/web/src/connection/storage.ts",
  "apps/web/src/editorPreferences.ts#message",
  "apps/web/src/hooks/useThreadActions.ts#message",
  // Workers cannot read the interface language, and the RPC replies are internal.
  "apps/web/src/components/files/binaryPreview.worker.ts",
  "apps/web/src/components/files/officePreview.worker.ts",
  "apps/web/src/components/files/office/worker-rpc.ts",
  // Fallback page names stored in the parsed document beside the file's own titles.
  "apps/web/src/components/files/extendedDocumentPreview.ts#title",
  // Saved as editable descriptor values that the model picker shows as written.
  "apps/web/src/components/settings/customModelEditor.logic.ts#label",
  // Search text matched against typed queries; the visible title is JSX.
  "apps/web/src/components/CommandPalette.tsx#searchTitle",
  // Host-named search entries built at module load; fixed titles translate where shown.
  "apps/web/src/components/settings/settingsSearch.ts#title",
  // Not rendered.
  "apps/web/src/components/RightPanelTabs.tsx#description",
  "apps/web/src/components/chat/MarkdownFileLink.logic.ts#title",
  "apps/web/src/versionSkew.ts#hint",
  // Translated when the row renders (timelineLabels.ts matches the template).
  "apps/web/src/components/chat/MessagesTimeline.logic.ts#label",
  // Work log fallbacks; the timeline builds translated labels in MessagesTimeline.logic.ts.
  "apps/web/src/session-logic.ts",
  // Action state labels; GitActionsControl.logic.ts compares the English one.
  "apps/web/src/state/sourceControlActions.ts#label",
  // Mobile counterparts of the entries above.
  // Sent to the server as the client's name in auth sessions.
  "apps/mobile/src/lib/authClientMetadata.ts#label",
  // The device name registered with the server, shown by other clients as written.
  "apps/mobile/src/features/agent-awareness/remoteRegistration.ts#label",
  // Prompt and title text written into the thread: model-facing text and user content.
  "apps/mobile/src/features/threads/resume-thread.ts#text",
  "apps/mobile/src/features/prompt-links/newTaskPromptLink.ts#title",
  "apps/mobile/src/lib/composerContext.ts#sectionTitle",
  "apps/mobile/src/features/terminal/TerminalContextSheet.tsx#label",
  "apps/mobile/src/features/terminal/TerminalContextSheet.tsx#terminalLabel",
  // Error objects that are logged or cross a boundary keep English where they are made.
  "apps/mobile/src/connection/catalog-store.ts#detail",
  "apps/mobile/src/connection/environment-cache-store.ts#message",
  "apps/mobile/src/connection/migration.ts#message",
  "apps/mobile/src/connection/platform.ts#detail",
  "apps/mobile/src/features/cloud/dpop.ts#message",
  // Sample source lines in the code preview.
  "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx#text",
  // Development screens that ship only in __DEV__ builds, and their sample data.
  "apps/mobile/src/Stack.tsx#title",
  "apps/mobile/src/features/showcase/showcaseEnvironmentRows.ts",
  "apps/mobile/src/features/showcase/showcasePendingTasks.ts",
  // Classification input: the tool's own title when the provider sends none; rows show the
  // translated label that the work-log presentation derives from it.
  "apps/mobile/src/lib/threadActivity.ts#toolTitle",
]);

/** A string literal that reads as copy: words with a space, a capital, or closing punctuation. */
const looksLikeCopy = (text: string) =>
  (/\s/u.test(text) || /^[A-Z][a-z]/u.test(text) || /[.?!:…]$/u.test(text)) &&
  // Class lists such as "text-xl font-semibold" are styling.
  !text.split(/\s+/u).every((token) => /[-:[]/u.test(token));

export interface PropertyHit {
  readonly line: number;
  readonly property: string;
  readonly text: string;
}

const isAllowlisted = (allowlist: ReadonlySet<string>, fileName: string, entry: string) =>
  allowlist.has(fileName) || allowlist.has(`${fileName}#${entry}`);

const propertyName = (property: AstNode): string | null => {
  if (property.computed === true) return null;
  const key = property.key as AstNode;
  if (key.type === "Identifier") return String(key.name);
  return key.type === "Literal" && typeof key.value === "string" ? key.value : null;
};

const calleeName = (callee: AstNode): string | null => {
  if (callee.type === "Identifier") return String(callee.name);
  if (callee.type === "MemberExpression" && (callee.property as AstNode).type === "Identifier") {
    return String((callee.property as AstNode).name);
  }
  return null;
};

/**
 * Interface copy assigned to object-literal properties. A plain literal that a catalog already
 * holds counts as translated where it shows, the documented pattern for module constants; an
 * interpolated template can never match a key, so it is always reported.
 */
export function scanPropertyText(
  code: string,
  fileName: string,
  known: ReadonlySet<string>,
  program: unknown = parseAst(code, { lang: fileName.endsWith(".tsx") ? "tsx" : "ts" }),
): ReadonlyArray<PropertyHit> {
  if (PROPERTY_ALLOWLIST.has(fileName)) return [];
  const hits: PropertyHit[] = [];
  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length;
  const operationOptions = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "CallExpression") {
      const name = calleeName(node.callee as AstNode);
      if (name !== null && OPERATION_LABEL_CALLS.has(name)) {
        for (const argument of node.arguments as ReadonlyArray<unknown>) {
          operationOptions.add(argument);
        }
      }
    } else if (node.type === "ObjectExpression") {
      for (const property of node.properties as ReadonlyArray<AstNode>) {
        if (property.type !== "Property" || property.method === true) continue;
        const name = propertyName(property);
        if (name === null || !(UI_PROPERTIES.has(name) || UI_PROPERTY_SUFFIX.test(name))) continue;
        if (name === "label" && operationOptions.has(node)) continue;
        if (isAllowlisted(PROPERTY_ALLOWLIST, fileName, name)) continue;
        for (const { start, text, interpolated } of displayStrings(property.value as AstNode)) {
          if (!interpolated && known.has(text)) continue;
          if (INTENTIONALLY_UNTRANSLATED.has(text)) continue;
          if (needsTranslation(text) && looksLikeCopy(text)) {
            hits.push({ line: lineOf(start), property: name, text });
          }
        }
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(program);
  return hits.toSorted((left, right) => left.line - right.line);
}

// fork: the "compared" section finds English sources that code compares against while the same
// source is translated elsewhere: once the compared value is translated, the comparison silently
// stops matching. Only sentence-like literals count; enum-like words are ids.
const COMPARE_ROOTS = [
  "apps/web/src",
  "apps/mobile/src",
  "apps/desktop/src",
  "packages/client-runtime/src",
  "packages/shared/src",
];
const COMPARE_METHODS = new Set(["endsWith", "has", "includes", "indexOf", "startsWith"]);
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]+$/u;

// `path#text` pairs checked to compare an untranslated value. Each needs a reason.
const COMPARED_ALLOWLIST = new Set([
  // The desktop app's raw endpoint names, translated when the address list renders.
  "apps/web/src/fork/endpointLabels.ts#This machine",
  "apps/web/src/fork/endpointLabels.ts#Local network",
  "apps/web/src/fork/endpointLabels.ts#Tailscale IP",
  "apps/web/src/fork/endpointLabels.ts#Custom HTTPS",
  "apps/web/src/fork/endpointLabels.ts#Custom endpoint",
  // The activity's raw summary, translated only when the row renders.
  "apps/mobile/src/features/threads/ThreadFeed.tsx#Context compacted",
  "apps/web/src/components/chat/MessagesTimeline.tsx#Context compacted",
  // The pending turn's raw status labels, compared and then translated where the row renders.
  "apps/mobile/src/features/threads/ThreadFeed.tsx#Starting…",
  "apps/mobile/src/features/threads/ThreadFeed.tsx#Sending…",
  // An English sentinel for a detached checkout; the label is translated where it shows.
  "apps/mobile/src/features/threads/git/GitBranchesSheet.tsx#Detached HEAD",
  // The raw heading from the device source, translated only when it renders.
  "apps/web/src/components/settings/DeviceSourcesSettings.tsx#Not available",
  // The stored project title.
  "apps/web/src/components/settings/ProjectSettingsPanel.tsx#No project",
  // The raw label the source control action state was started with.
  "apps/web/src/components/GitActionsControl.logic.ts#Running source control action",
  // The stored placeholder thread title, matched so it can show translated.
  "packages/client-runtime/src/operations/threadTitle.ts#New thread",
]);

const sentenceLike = (text: string) =>
  ENGLISH_WORD.test(text) && (/\s/u.test(text) || /[.?!:;,…]$/u.test(text));

export interface Comparison {
  readonly line: number;
  readonly operator: string;
  /** The compared text, or an upper-case constant's name to resolve across files. */
  readonly text: string | null;
  readonly constant: string | null;
}

export interface ComparisonScan {
  readonly comparisons: ReadonlyArray<Comparison>;
  readonly constants: ReadonlyMap<string, string>;
}

export function scanComparisons(
  code: string,
  fileName: string,
  program: unknown = parseAst(code, { lang: fileName.endsWith(".tsx") ? "tsx" : "ts" }),
): ComparisonScan {
  const comparisons: Comparison[] = [];
  const constants = new Map<string, string>();
  const lineOf = (offset: number) => code.slice(0, offset).split("\n").length;
  const record = (operand: unknown, start: number, operator: string) => {
    if (!isAstNode(operand)) return;
    if (operand.type === "Literal" && typeof operand.value === "string") {
      comparisons.push({ line: lineOf(start), operator, text: operand.value, constant: null });
    } else if (
      operand.type === "TemplateLiteral" &&
      (operand.expressions as ReadonlyArray<unknown>).length === 0
    ) {
      const [quasi] = operand.quasis as ReadonlyArray<{ value: { cooked: string } }>;
      comparisons.push({
        line: lineOf(start),
        operator,
        text: quasi!.value.cooked,
        constant: null,
      });
    } else if (operand.type === "Identifier" && CONSTANT_NAME.test(String(operand.name))) {
      comparisons.push({
        line: lineOf(start),
        operator,
        text: null,
        constant: String(operand.name),
      });
    }
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "VariableDeclarator") {
      const id = node.id as AstNode;
      const init = node.init as AstNode | null;
      if (
        id.type === "Identifier" &&
        CONSTANT_NAME.test(String(id.name)) &&
        init?.type === "Literal" &&
        typeof init.value === "string"
      ) {
        constants.set(String(id.name), init.value);
      }
    } else if (node.type === "BinaryExpression" && /^[!=]==?$/u.test(String(node.operator))) {
      record(node.left, node.start, String(node.operator));
      record(node.right, node.start, String(node.operator));
    } else if (node.type === "SwitchCase") {
      record(node.test, node.start, "case");
    } else if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      const method = callee.type === "MemberExpression" ? calleeName(callee) : null;
      if (method !== null && COMPARE_METHODS.has(method)) {
        record((node.arguments as ReadonlyArray<unknown>)[0], node.start, `.${method}()`);
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(program);
  return { comparisons, constants };
}

/** Comparisons against a sentence-like source that some call site also translates. */
export function riskyComparisons(
  scans: ReadonlyArray<readonly [file: string, scan: ComparisonScan]>,
  translated: { has(source: string): boolean },
): ReadonlyArray<{
  readonly file: string;
  readonly line: number;
  readonly operator: string;
  readonly text: string;
}> {
  const constants = new Map<string, string>();
  for (const [, scan] of scans)
    for (const [name, value] of scan.constants) constants.set(name, value);
  return scans.flatMap(([file, scan]) =>
    scan.comparisons.flatMap(({ line, operator, text, constant }) => {
      const resolved = text ?? (constant === null ? undefined : constants.get(constant));
      if (resolved === undefined || !sentenceLike(resolved) || !translated.has(resolved)) return [];
      if (COMPARED_ALLOWLIST.has(`${file}#${resolved}`)) return [];
      return [{ file, line, operator, text: resolved }];
    }),
  );
}

// fork: the "omitted translator" section finds callers of a function whose translator parameter
// is optional or defaulted to English (`t: Translator = translatorFor("en")`) that leave it out:
// the call site has no t() for the scan above to see, and the text silently stays English.
const TRANSLATOR_PARAMETER = /\bTranslator\b/u;

export interface TranslatorParameter {
  readonly name: string;
  /** Position of the translator among the parameters. */
  readonly index: number;
}

export interface CallArity {
  readonly line: number;
  readonly name: string;
  readonly argumentCount: number;
}

const functionNodes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/** Functions with an optional or defaulted `Translator` parameter, by the name they are bound to. */
export function scanTranslatorParameters(
  code: string,
  fileName: string,
  program: unknown = parseAst(code, { lang: fileName.endsWith(".tsx") ? "tsx" : "ts" }),
): ReadonlyArray<TranslatorParameter> {
  const found: TranslatorParameter[] = [];
  const bind = (name: string | null, fn: AstNode) => {
    if (name === null) return;
    (fn.params as ReadonlyArray<AstNode>).forEach((parameter, index) => {
      const text = code.slice(parameter.start, parameter.end as number);
      // A default that reads the interface language (`translatorFor(getUiLocale())`) is not English.
      const defaulted = parameter.type === "AssignmentPattern" && !text.includes("getUiLocale");
      const optional = parameter.type === "Identifier" && parameter.optional === true;
      if ((defaulted || optional) && TRANSLATOR_PARAMETER.test(text.split("=")[0]!)) {
        found.push({ name, index });
      }
    });
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "FunctionDeclaration" && isAstNode(node.id)) {
      bind(String(node.id.name), node);
    } else if (node.type === "VariableDeclarator" && isAstNode(node.id) && isAstNode(node.init)) {
      const init = unwrapExpression(node.init);
      if (init !== null && functionNodes.has(init.type) && node.id.type === "Identifier") {
        bind(String(node.id.name), init);
      }
    } else if (
      (node.type === "Property" || node.type === "MethodDefinition") &&
      isAstNode(node.value) &&
      functionNodes.has(node.value.type)
    ) {
      bind(propertyName(node), node.value);
    }
    Object.values(node).forEach(walk);
  };
  walk(program);
  return found;
}

/** Calls by callee name (`fn(...)` and `obj.fn(...)`) with their argument count; spreads are skipped. */
export function scanCallArities(
  code: string,
  fileName: string,
  program: unknown = parseAst(code, { lang: fileName.endsWith(".tsx") ? "tsx" : "ts" }),
): ReadonlyArray<CallArity> {
  const calls: CallArity[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "CallExpression") {
      const name = calleeName(node.callee as AstNode);
      const args = node.arguments as ReadonlyArray<AstNode>;
      if (name !== null && !args.some((argument) => argument.type === "SpreadElement")) {
        calls.push({
          line: code.slice(0, node.start).split("\n").length,
          name,
          argumentCount: args.length,
        });
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(program);
  return calls;
}

// `path#name` pairs whose callers may leave the translator out. Each needs a reason.
const OMITTED_TRANSLATOR_ALLOWLIST = new Set([
  // Only the events' links are matched; no title is shown.
  "apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx#buildPullRequestTimeline",
  // Only the number of errors is read.
  "apps/web/src/components/settings/scheduledTasksSettings.logic.ts#scheduleDraftErrors",
  // `row.conflicts` is not rendered; the settings rows call keybindingConflictLabels with `t`.
  "apps/web/src/components/settings/KeybindingsSettings.logic.ts#keybindingConflictLabels",
  // A prop of the field, not the translated formatter that shares its name.
  "apps/mobile/src/components/ui/NumberField.tsx#formatValue",
  "apps/mobile/src/components/ui/NumberField.android.tsx#formatValue",
]);

/** Calls that stop before a translator parameter of the function they name. */
export function omittedTranslators(
  parameters: ReadonlyMap<string, number>,
  scans: ReadonlyArray<readonly [file: string, calls: ReadonlyArray<CallArity>]>,
): ReadonlyArray<{ readonly file: string; readonly line: number; readonly name: string }> {
  return scans.flatMap(([file, calls]) =>
    calls.flatMap(({ line, name, argumentCount }) => {
      const index = parameters.get(name);
      if (index === undefined || argumentCount > index) return [];
      if (OMITTED_TRANSLATOR_ALLOWLIST.has(`${file}#${name}`)) return [];
      return [{ file, line, name }];
    }),
  );
}

function omittedTranslatorSection(): Section {
  // A name defined twice keeps its earliest translator position: a call that stops short of it
  // omits the translator for at least one of the definitions.
  const parameters = new Map<string, number>();
  const perRoot = COMPARE_ROOTS.map((root) => {
    const files = sourceFiles(root)
      .toSorted()
      .map((file) => {
        const code = NodeFS.readFileSync(file, "utf8");
        const program = parseSource(file, code);
        for (const { name, index } of scanTranslatorParameters(code, file, program)) {
          parameters.set(name, Math.min(index, parameters.get(name) ?? index));
        }
        return [file, scanCallArities(code, file, program)] as const;
      });
    return [root, files] as const;
  });
  const hits = omittedTranslators(
    parameters,
    perRoot.flatMap(([, files]) => files),
  );
  return section(
    "calls that leave out a function's optional translator, so its fixed text stays English; the allowlist is in scripts/i18n-report.ts",
    "omitted translator",
    COMPARE_ROOTS.map((root) => {
      const rootHits = hits.filter(({ file }) => file.startsWith(`${root}/`));
      return [
        root,
        rootHits.map(({ file, line, name }) => `    ${file}:${line} ${name}()`),
        rootHits.length,
      ] as const;
    }),
  );
}

interface Section {
  readonly lines: ReadonlyArray<string>;
  readonly total: number;
}

function section(
  title: string,
  label: string,
  perRoot: ReadonlyArray<readonly [root: string, lines: ReadonlyArray<string>, count: number]>,
): Section {
  const total = perRoot.reduce((sum, [, , count]) => sum + count, 0);
  return {
    lines: [
      "",
      `${label} (${total}): ${title}`,
      ...perRoot.flatMap(([, lines]) => lines),
      "",
      `  ${label} total ${total} (${perRoot.map(([root, , count]) => `${root}: ${count}`).join(", ")})`,
    ],
    total,
  };
}

function hardCodedSections(
  called: Map<string, string>,
  known: ReadonlySet<string>,
): readonly [Section, Section] {
  const jsx: Array<readonly [string, string[], number]> = [];
  const properties: Array<readonly [string, string[], number]> = [];
  for (const root of HARD_CODED_ROOTS) {
    const jsxLines: string[] = [];
    const propertyLines: string[] = [];
    let jsxCount = 0;
    let propertyCount = 0;
    const files = sourceFilesIn(root)
      .filter((file) => !HARD_CODED_EXCLUDED_DIRS.some((dir) => file.startsWith(dir)))
      .toSorted();
    for (const file of files) {
      const code = NodeFS.readFileSync(file, "utf8");
      const program = parseSource(file, code);
      if (file.endsWith(".tsx")) {
        const { hits, selfTranslated } = scanHardCodedText(code, file, program);
        for (const source of selfTranslated) {
          if (!called.has(source)) called.set(source, file);
        }
        if (hits.length > 0) {
          jsxCount += hits.length;
          jsxLines.push("", `  ${file} (${hits.length})`);
          for (const { line, kind, text } of hits)
            jsxLines.push(`    ${file}:${line} [${kind}] ${text}`);
        }
      }
      const hits = scanPropertyText(code, file, known, program);
      if (hits.length === 0) continue;
      propertyCount += hits.length;
      propertyLines.push("", `  ${file} (${hits.length})`);
      for (const { line, property, text } of hits) {
        propertyLines.push(`    ${file}:${line} [${property}] ${text}`);
      }
    }
    jsx.push([root, jsxLines, jsxCount]);
    properties.push([root, propertyLines, propertyCount]);
  }
  return [
    section(
      "English JSX that bypasses t(); allowlists are in scripts/i18n-report.ts",
      "hard-coded",
      jsx,
    ),
    section(
      "object-literal copy in .ts and .tsx that bypasses t(); allowlists are in scripts/i18n-report.ts",
      "hard-coded (properties)",
      properties,
    ),
  ];
}

function comparedSection(called: ReadonlyMap<string, string>): Section {
  const perRoot = COMPARE_ROOTS.map((root) => {
    const scans = sourceFiles(root)
      .toSorted()
      .map((file) => {
        const code = NodeFS.readFileSync(file, "utf8");
        return [file, scanComparisons(code, file, parseSource(file, code))] as const;
      });
    return [root, scans] as const;
  });
  const risky = riskyComparisons(
    perRoot.flatMap(([, scans]) => scans),
    called,
  );
  return section(
    "English sources compared in code and translated elsewhere; the allowlist is in scripts/i18n-report.ts",
    "compared",
    COMPARE_ROOTS.map((root) => {
      const hits = risky.filter(({ file }) => file.startsWith(`${root}/`));
      return [
        root,
        hits.map(
          ({ file, line, operator, text }) =>
            `    ${file}:${line} ${operator} ${JSON.stringify(text)}`,
        ),
        hits.length,
      ] as const;
    }),
  );
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
  // fork: the catalog keys direct calls need, per source; null stands for a context not in the code.
  const neededKeys = new Map<string, Set<string | null>>();
  const literals = new Set<string>();
  const templates: RegExp[] = [];
  for (const file of roots.flatMap(sourceFiles)) {
    const text = NodeFS.readFileSync(file, "utf8");
    for (const match of text.matchAll(ANY_STRING)) literals.add(unescape(match[1]!));
    // JSX attribute strings are not JS string literals, but carry English sources too.
    for (const match of text.matchAll(/=\s*"([^"\n]*)"/g)) literals.add(match[1]!);
    for (const match of text.matchAll(INTERPOLATED_TEMPLATE)) {
      const pattern = templateSourcePattern(match[1]!);
      if (pattern !== null) templates.push(pattern);
    }
    for (const pattern of CALL_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const source = quotedSource(match);
        // A called source is in code even when quote pairing above went off track.
        literals.add(source);
        if (!called.has(source)) called.set(source, NodePath.relative(process.cwd(), file));
      }
    }
    const tableProperties = TRANSLATED_PROPERTY_TABLES.get(NodePath.relative(process.cwd(), file));
    if (tableProperties !== undefined) {
      for (const { line, source } of scanTranslatedTable(
        text,
        file,
        tableProperties,
        parseSource(file, text),
      )) {
        literals.add(source);
        if (!called.has(source)) called.set(source, `${file}:${line}`);
        // Read through a bare t(variable): a "context|source" entry does not serve it.
        neededKeys.set(source, (neededKeys.get(source) ?? new Set<string | null>()).add(source));
      }
    }
    // fork: curried translators and label tables read through t() carry sources too.
    if (!TRANSLATOR_USE.test(text)) continue;
    for (const call of scanCallKeys(text, file, parseSource(file, text))) {
      const needed = neededKeys.get(call.source) ?? new Set<string | null>();
      needed.add(callCatalogKey(call));
      neededKeys.set(call.source, needed);
    }
    for (const { line, source } of scanIndirectSources(text, file, parseSource(file, text))) {
      literals.add(source);
      if (!called.has(source)) called.set(source, `${file}:${line}`);
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

  const locales = NodeFS.readdirSync(CATALOG_ROOT);
  const keysByLocale = new Map(locales.map((locale) => [locale, catalogKeys(locale)]));
  const known = new Set([...keysByLocale.values()].flat().map(catalogKeySource));
  const [hardCoded, hardCodedProperties] = hardCodedSections(called, known);
  const compared = comparedSection(called);
  const omitted = omittedTranslatorSection();
  const lines: string[] = [];
  let missingTotal = 0;
  let staleTotal = 0;
  for (const locale of locales) {
    const keys = keysByLocale.get(locale)!;
    const sources = new Set(keys.map(catalogKeySource));
    const exactKeys = new Set(keys);
    const missing = [...called].filter(
      ([source]) =>
        !INTENTIONALLY_UNTRANSLATED.has(source) &&
        (!sources.has(source) ||
          // fork: a contextual entry only serves calls that pass its context.
          [...(neededKeys.get(source) ?? [])].some((key) => key !== null && !exactKeys.has(key))),
    );
    const stale = keys.filter((key) => {
      const source = catalogKeySource(key);
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
    ...hardCodedProperties.lines,
    ...compared.lines,
    ...omitted.lines,
    "",
    `i18n report: ${missingTotal} missing, ${staleTotal} stale, ${hardCoded.total} hard-coded, ${hardCodedProperties.total} hard-coded (properties), ${compared.total} compared, ${omitted.total} omitted translator (report only)`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (import.meta.main) main();
