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

/** Every string a node can evaluate to, with each `${…}` filled from `samples` (or a number). */
function strings(
  node: Node | null | undefined,
  code: string,
  samples: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!node) return [];
  if (node.type === "Literal") return typeof node.value === "string" ? [node.value] : [];
  if (node.type === "ConditionalExpression")
    return [...strings(node.consequent, code, samples), ...strings(node.alternate, code, samples)];
  if (node.type !== "TemplateLiteral") return [];
  let results = [""];
  node.quasis.forEach((quasi: Node, index: number) => {
    results = results.map((text) => text + quasi.value.cooked);
    const expression = node.expressions[index] as Node | undefined;
    if (!expression) return;
    const options = samples.get(code.slice(expression.start, expression.end)) ?? ["7"];
    results = results.flatMap((text) => options.map((option) => text + option));
  });
  return results;
}

/**
 * The reasons storageCleanup.ts can put in a report entry: the arguments of `keep` and
 * `waitForStop`, `reason:` properties, `removalReason`, and returned literals, with the dynamic
 * parts of a template filled in.
 */
function serverReasons(): string[] {
  const code = NodeFS.readFileSync(SERVER_SOURCE, "utf8");
  const program = parseAst(code, { lang: "ts" }) as unknown as Node;
  const samples = new Map<string, readonly string[]>([
    ["OFFICIAL_APP_NAME", [OFFICIAL_APP_NAME]],
    ["count", ["1", "7"]],
    [`count === 1 ? "file" : "files"`, ["file", "files"]],
  ]);
  const roots: Node[] = [];
  let localChanges: Node | undefined;
  walk(program, (node) => {
    if (
      node.type === "Property" &&
      node.key?.name === "label" &&
      node.value?.type === "Literal" &&
      typeof node.value.value === "string"
    )
      samples.set("category.label", [...(samples.get("category.label") ?? []), node.value.value]);
    if (node.type === "VariableDeclarator" && node.id?.name === "localChangesReason")
      localChanges = node.init;
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
    if (node.type === "ReturnStatement") roots.push(node.argument);
  });
  // The submodule reasons are "submodule " followed by what localChangesReason returned.
  const changes: string[] = [];
  walk(localChanges, (node) => {
    if (node.type === "ReturnStatement") changes.push(...strings(node.argument, code, samples));
  });
  samples.set("changes", changes);

  const found = new Set<string>();
  for (const root of roots) for (const text of strings(root, code, samples)) found.add(text);
  return (
    [...found]
      .filter((text) => /^[A-Za-z]/.test(text))
      // `1 files` and `7 file` are cross products of the samples above, not server output.
      .filter((text) => !/\b1 files|\b7 file\b/.test(text))
      // keep() and the removal reasons go through the server's `sentence`, which capitalises.
      .map((text) => text.charAt(0).toUpperCase() + text.slice(1))
  );
}

await loadUiCatalog("zh-Hans");
const zh = translatorFor("zh-Hans");

const tagged = (source: string) => `tagged:${source}`;

describe("storage clean-up reasons", () => {
  it("translates every reason the server can produce in zh-Hans", () => {
    const untranslated = serverReasons().filter(
      (reason) => !/\p{Script=Han}/u.test(localizeCleanupReason(reason, zh)),
    );
    expect(untranslated).toEqual([]);
  });

  it("looks up every reason the server can produce", () => {
    const reasons = serverReasons();
    // The extractor reads the server source; a refactor that hides the reasons must not pass quietly.
    expect(reasons.length).toBeGreaterThan(45);
    const unlisted = reasons.filter(
      (reason) => !localizeCleanupReason(reason, tagged).startsWith("tagged:"),
    );
    expect(unlisted).toEqual([]);
    const unused = STORAGE_CLEANUP_REASON_TEMPLATES.filter(
      (source) =>
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
