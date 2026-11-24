// @effect-diagnostics nodeBuiltinImport:off - reads the server source on disk to list its reasons.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { OFFICIAL_APP_NAME } from "@t3tools/contracts";
import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";
import { describe, expect, it } from "vite-plus/test";
import { parseAst } from "vite-plus";

import { localizeCleanupReason, STORAGE_CLEANUP_REASON_TEMPLATES } from "./storageCleanupReasons";

type Node = { readonly type: string; readonly start: number; readonly end: number } & Record<
  string,
  any
>;

const SERVER_SOURCE = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../server/src/storageCleanup.ts",
);

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (!isNode(node)) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) if (key !== "parent") walk(value, visit);
}

type Samples = ReadonlyMap<string, readonly string[]>;

/** A reason-root node the extractor neither evaluates nor has classified. */
interface Unrecognised {
  readonly line: number;
  readonly text: string;
}

/**
 * Reason roots that are not string literals, each with why the extractor may skip it. The match is
 * on source text. A root outside this list and outside what `evaluate` reads is reported, so a new
 * way of building a reason fails the test instead of leaving the Chinese UI in English.
 */
const CLASSIFIED: ReadonlyArray<{ readonly match: RegExp; readonly why: string }> = [
  {
    match: /^cleanupFailureReason\(/,
    why: "raw git or error text; server error text stays as the server wrote it (FORK.md), so it passes through",
  },
  {
    match: /^reason$/,
    why: "keep()'s and waitForStop()'s own parameter; the values are their call sites, which are roots",
  },
  {
    match: /^(?:removalReason|sharedKeepReason|notDueReason)$/,
    why: "a variable whose initialiser and assignments are roots themselves",
  },
  {
    match:
      /^(?:changes|finalChanges|blocked|blockedWhileMeasuring|blockedTaskFolder|blockedSinceLease|pathReason|hidden)$/,
    why: "the result of localChangesReason, blockedSinceCheck, scratchKeepReason, worktreePathReason or hiddenTrackedChange, whose returns are evaluated below",
  },
  {
    match: /^measureReason$/,
    why: "measureWorktreeBounded's `reason:` properties, which are roots themselves",
  },
  {
    match: /^keptCheckout\.reason$/,
    why: "a checkout the task folder kept: inspectCheckout's `keep` strings, which are roots, TaskFolders' own sentences (listed in FROM_OTHER_FILES) or a git error shown as written",
  },
  {
    match: /^(?:inspection|finalInspection)\.reason$/,
    why: "measureWorktree's `reason:` properties, which are roots themselves",
  },
  {
    match: /^Effect\.fn\("StorageCleanup\.(?:scratchKeepReason|worktreePathReason)"\)/,
    why: "the functions that return those reasons; their returns are evaluated below",
  },
  {
    match: /^yield\* worktreePathReason\(/,
    why: "the result of worktreePathReason, whose returns are evaluated below",
  },
  {
    match: /^kept$/,
    why: "the exclusive section's result: submodules.reason (a `reason:` root), changes, or sharedKeepReason",
  },
  {
    match: /^Effect\.fn\("StorageCleanup\.localChangesReason"\)/,
    why: "the function that returns those reasons; its returns are evaluated below",
  },
  {
    match: /^yield\* sharedWorktrees\s*\.refusal\(/,
    why: "only compared with null; its text is never shown, the report gets sharedKeepReason",
  },
];

/** `${…}` values that are numbers or text the server fills in; the template's placeholder takes any. */
const DYNAMIC_VALUES: ReadonlyArray<{ readonly match: RegExp; readonly why: string }> = [
  {
    match: /^(?:members\.length|files|settledDays|settings\.\w+Days|Math\.floor\(.*\))$/,
    why: "a count or a number of days, read by the \\d+ placeholders",
  },
  { match: /^file$/, why: "a file name from git, shown as the server wrote it" },
  { match: /^adminDir$/, why: "a path in the repository's git directory" },
  {
    match: /^cleanupFailureReason\(\w+\)$/,
    why: "raw git or error text, shown as the server wrote it",
  },
];

/** Sentences TaskFolders.remove returns for a kept checkout; storageCleanup.ts only forwards them. */
const FROM_OTHER_FILES: ReadonlySet<string> = new Set([
  "Holds a repository that was kept",
  "Has files that exist only in this folder",
]);

function lineOf(code: string, node: Node): number {
  return code.slice(0, node.start).split("\n").length;
}

/**
 * Every string a node can evaluate to, with each `${…}` filled from `samples`. Nodes that are
 * neither evaluated nor in CLASSIFIED go to `unrecognised`.
 */
function evaluate(
  node: Node | null | undefined,
  code: string,
  samples: Samples,
  unrecognised: Unrecognised[],
): string[] {
  if (!node) return [];
  const text = code.slice(node.start, node.end);
  const recurse = (inner: Node | null | undefined) => evaluate(inner, code, samples, unrecognised);
  switch (node.type) {
    case "Literal":
      // `reason: null` means no reason; other literals are not text.
      if (typeof node.value === "string") return [node.value];
      if (node.value === null) return [];
      break;
    case "ConditionalExpression":
      return [...recurse(node.consequent), ...recurse(node.alternate)];
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
      return recurse(node.expression);
    case "CallExpression":
      // keep(), waitForStop() and the server's `sentence` only wrap the text they are given.
      if (
        node.callee?.type === "Identifier" &&
        ["keep", "waitForStop", "sentence"].includes(node.callee.name)
      )
        return node.arguments.flatMap((argument: Node) => recurse(argument));
      break;
    case "TemplateLiteral": {
      let results = [""];
      node.quasis.forEach((quasi: Node, index: number) => {
        results = results.map((result) => result + quasi.value.cooked);
        const expression = node.expressions[index] as Node | undefined;
        if (!expression) return;
        const expressionText = code.slice(expression.start, expression.end);
        const options = samples.get(expressionText);
        if (
          options === undefined &&
          !DYNAMIC_VALUES.some(({ match }) => match.test(expressionText))
        )
          unrecognised.push({ line: lineOf(code, expression), text: `\${${expressionText}}` });
        const values = options ?? ["7"];
        results = results.flatMap((result) => values.map((value) => result + value));
      });
      return results;
    }
  }
  if (!CLASSIFIED.some(({ match }) => match.test(text)))
    unrecognised.push({ line: lineOf(code, node), text });
  return [];
}

/**
 * The reasons storageCleanup.ts can put in a report entry, and the reason roots it could not read.
 * Roots are `keep` and `waitForStop` arguments, `reason:` properties, `*Reason` initialisers and
 * `removalReason` assignments. Returned literals are added on a best-effort basis.
 */
function serverReasons(): { reasons: string[]; unrecognised: Unrecognised[] } {
  const code = NodeFS.readFileSync(SERVER_SOURCE, "utf8");
  const program = parseAst(code, { lang: "ts" }) as unknown as Node;
  const samples = new Map<string, readonly string[]>([
    ["OFFICIAL_APP_NAME", [OFFICIAL_APP_NAME]],
    ["count", ["1", "7"]],
    [`count === 1 ? "file" : "files"`, ["file", "files"]],
  ]);
  const roots: Node[] = [];
  const returns: Node[] = [];
  const functions = new Map<string, Node | undefined>();
  walk(program, (node) => {
    if (
      node.type === "Property" &&
      node.key?.name === "label" &&
      node.value?.type === "Literal" &&
      typeof node.value.value === "string"
    )
      samples.set("category.label", [...(samples.get("category.label") ?? []), node.value.value]);
    if (
      node.type === "VariableDeclarator" &&
      ["localChangesReason", "blockedSinceCheck"].includes(node.id?.name)
    )
      functions.set(node.id.name, node.init);
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      (node.callee.name === "keep" || node.callee.name === "waitForStop")
    )
      roots.push(...node.arguments);
    if (node.type === "Property" && node.key?.name === "reason") roots.push(node.value);
    if (node.type === "VariableDeclarator" && /Reason$/.test(node.id?.name ?? ""))
      roots.push(node.init);
    if (node.type === "AssignmentExpression" && node.left?.name === "removalReason")
      roots.push(node.right);
    if (node.type === "ReturnStatement" && node.argument) returns.push(node.argument);
  });
  const unrecognised: Unrecognised[] = [];
  // The returns of the two functions whose results keep() forwards, without their nested functions.
  const returnsOf = (name: string): Node[] => {
    const init = functions.get(name);
    // A refactor that moves them must fail here, not drop their reasons.
    expect(init, `${name} not found in the server source`).toBeDefined();
    const result: Node[] = [];
    let entered = false;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!isNode(node)) return;
      if (/Function/.test(node.type)) {
        if (entered) return;
        entered = true;
      }
      if (node.type === "ReturnStatement" && node.argument) result.push(node.argument);
      for (const [key, value] of Object.entries(node)) if (key !== "parent") visit(value);
    };
    visit(init);
    return result;
  };
  // The submodule reasons are "submodule " followed by what localChangesReason returned.
  const changes = returnsOf("localChangesReason").flatMap((node) =>
    evaluate(node, code, samples, unrecognised),
  );
  samples.set("changes", changes);
  const forwarded = returnsOf("blockedSinceCheck").flatMap((node) =>
    evaluate(node, code, samples, unrecognised),
  );

  const found = new Set<string>([...changes, ...forwarded]);
  for (const root of roots)
    for (const text of evaluate(root, code, samples, unrecognised)) found.add(text);
  for (const node of returns) for (const text of evaluate(node, code, samples, [])) found.add(text);
  const reasons = [...found]
    .filter((text) => /^[A-Za-z]/.test(text))
    // `1 files` and `7 file` are cross products of the samples above, not server output.
    .filter((text) => !/\b1 files|\b7 file\b/.test(text))
    // keep() and the removal reasons go through the server's `sentence`, which capitalises.
    .map((text) => text.charAt(0).toUpperCase() + text.slice(1));
  return { reasons, unrecognised };
}

await loadUiCatalog("zh-Hans");
const zh = translatorFor("zh-Hans");

const tagged = (source: string) => `tagged:${source}`;

describe("storage clean-up reasons", () => {
  it("translates every reason the server can produce in zh-Hans", () => {
    const untranslated = serverReasons().reasons.filter(
      (reason) => !/\p{Script=Han}/u.test(localizeCleanupReason(reason, zh)),
    );
    expect(untranslated).toEqual([]);
  });

  it("looks up every reason the server can produce", () => {
    const { reasons, unrecognised } = serverReasons();
    expect(unrecognised).toEqual([]);
    // The extractor reads the server source; a refactor that hides the reasons must not pass quietly.
    expect(reasons.length).toBeGreaterThan(45);
    const unlisted = reasons.filter(
      (reason) => !localizeCleanupReason(reason, tagged).startsWith("tagged:"),
    );
    expect(unlisted).toEqual([]);
    const unused = STORAGE_CLEANUP_REASON_TEMPLATES.filter(
      (source) =>
        !FROM_OTHER_FILES.has(source) &&
        !reasons.some((reason) => localizeCleanupReason(reason, tagged) === tagged(source)),
    );
    expect(unused).toEqual([]);
  });

  it("fills placeholders from the reason and leaves unknown text alone", () => {
    expect(localizeCleanupReason("Inactive for 3 of 7 days", tagged)).toBe(
      "tagged:Inactive for {days} of {limit} days",
    );
    expect(localizeCleanupReason("Inactive for 12 days", tagged)).toBe(
      "tagged:Inactive for {days} days",
    );
    expect(localizeCleanupReason(`Shared with ${OFFICIAL_APP_NAME}`, tagged)).toBe(
      "tagged:Shared with {app}",
    );
    expect(localizeCleanupReason("Shared with Another App", tagged)).toBe(
      "Shared with Another App",
    );
    expect(localizeCleanupReason("git worktree remove: fatal: not a repository", tagged)).toBe(
      "git worktree remove: fatal: not a repository",
    );
    const t = (source: string, params?: Record<string, string | number>) =>
      source.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name]));
    expect(localizeCleanupReason("Removed 4 rotated logs", t)).toBe("Removed 4 rotated logs");
    expect(localizeCleanupReason("Has ignored files (.env)", t)).toBe("Has ignored files (.env)");
  });
});
