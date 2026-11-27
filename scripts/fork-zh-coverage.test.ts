// @effect-diagnostics nodeBuiltinImport:off - a plain file scan over the source tree.
// fork: in a Chinese interface, the copy of T3 Extend's own features must be Chinese. Their text goes
// through either the fork's t() (zh-Hans catalog) or upstream's GT (gt(), msg(), <T>, so zh.json);
// a sentence with no Chinese behind it would quietly show English after an upstream sync.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseAst } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

import { ZH_HANS_AREAS } from "../packages/client-runtime/src/i18n/catalogs/zh-Hans/index.ts";

const FEATURES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "footer ports": ["apps/web/src/fork/FooterPorts.tsx"],
  "antigravity account refresh": [
    "apps/web/src/fork/RefreshAccountUsage.tsx",
    "apps/mobile/src/fork/RefreshAccountUsage.tsx",
  ],
  "device keys": [
    "apps/web/src/fork/YourServerSettings.tsx",
    "apps/web/src/fork/YourServerVisibility.tsx",
    "apps/web/src/fork/YourServerPaletteItems.tsx",
    "apps/mobile/src/fork/deviceKeys",
  ],
  UnifiedPush: ["apps/mobile/src/fork/push"],
  outputs: ["apps/web/src/components/chat/outputs", "apps/mobile/src/features/outputs"],
  "context meter": [
    "apps/web/src/components/chat/ComposerContextMeter.tsx",
    "apps/mobile/src/features/threads/ComposerContextMeter.tsx",
  ],
  "background service": [
    "apps/web/src/fork/BackgroundServiceSettings.tsx",
    "apps/web/src/fork/BackgroundServiceReporter.tsx",
  ],
  "theme studio": ["apps/web/src/fork/themeStudio"],
  "antigravity accounts": [
    "apps/web/src/fork/AntigravityAccounts.tsx",
    "apps/mobile/src/fork/AntigravityAccounts.tsx",
    "apps/web/src/fork/AccountUsageList.tsx",
    "apps/mobile/src/fork/AccountUsageList.tsx",
  ],
  "split right panel": [
    "apps/web/src/fork/rightPanelSplitMenu.ts",
    "apps/web/src/fork/RightPanelSplitHost.tsx",
  ],
  "message bookmarks": ["apps/web/src/fork/bookmarks", "apps/mobile/src/features/bookmarks"],
  "sidebar by project": [
    "apps/web/src/components/sidebar/SidebarViewToggle.tsx",
    "apps/web/src/components/sidebar/SidebarWorktreeGroupHeader.tsx",
    "apps/web/src/components/CommandPaletteSidebarViewItems.tsx",
    "apps/mobile/src/fork/ThreadListGroupHeader.tsx",
  ],
};

// Text that reads the same in Chinese: product and protocol names, units.
// Token counts stay English by the glossary; font stacks are sample values.
const ALWAYS_ENGLISH =
  /^(?:[^a-z]*|T3 Extend|UnifiedPush|ntfy|frpc?|localhost|HTTPS?|PID|.*\btokens|[\w ]+, (?:serif|sans-serif|monospace))$/u;

const root = NodePath.resolve(import.meta.dirname, "..");
const HAN = /\p{Script=Han}/u;

type Node = { readonly type: string; readonly [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";
const stringOf = (node: unknown): string | null =>
  isNode(node) && node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : isNode(node) &&
        node.type === "TemplateLiteral" &&
        (node.expressions as unknown[]).length === 0
      ? String(((node.quasis as Node[])[0]!.value as { cooked: string }).cooked)
      : null;
const calleeName = (node: Node) => {
  const callee = node.callee as Node;
  return callee.type === "Identifier" ? String(callee.name) : null;
};

/** Sources a file hands to each translator: the fork's t() and GT's gt()/msg()/<T>. */
function sourcesOf(file: string) {
  const code = NodeFS.readFileSync(file, "utf8");
  const program = parseAst(code, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  const fork: string[] = [];
  const gt: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    if (node.type === "CallExpression") {
      const name = calleeName(node);
      const first = stringOf((node.arguments as unknown[])[0]);
      // t(source, params, context) keys the catalog as "context|source".
      const context = stringOf((node.arguments as unknown[])[2]);
      if (first !== null && name === "t")
        fork.push(context === null ? first : `${context}|${first}`);
      if (first !== null && (name === "gt" || name === "msg")) gt.push(first);
    }
    if (node.type === "JSXElement") {
      const opening = node.openingElement as Node;
      const name = (opening.name as Node).name;
      if (name === "T") {
        const text = (node.children as Node[])
          .filter((child) => child.type === "JSXText")
          .map((child) => String(child.value))
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
        if (text) gt.push(text);
      }
    }
    for (const [key, value] of Object.entries(node)) if (key !== "parent") visit(value);
  };
  visit(program);
  return { fork, gt };
}

function filesIn(path: string): string[] {
  const absolute = NodePath.join(root, path);
  if (!NodeFS.statSync(absolute).isDirectory()) return [absolute];
  return NodeFS.readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/u.test(name) && !/\.test\.|\.browser\./u.test(name))
    .map((name) => NodePath.join(absolute, name));
}

// GT keys hash the source, so look the sentence up through each app's en.json.
const gtZh = new Map<string, string>();
for (const app of ["web", "mobile", "desktop"]) {
  const dir = NodePath.join(root, "apps", app, "src/i18n/translations");
  const en = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "en.json"), "utf8"));
  const zh = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "zh.json"), "utf8"));
  for (const [key, value] of Object.entries(en)) {
    if (typeof value === "string" && typeof zh[key] === "string") gtZh.set(value, zh[key]);
  }
}
const forkZh = new Map<string, string>(
  Object.values(ZH_HANS_AREAS).flatMap((area) => Object.entries(area) as Array<[string, string]>),
);

describe("fork features in a Chinese interface", () => {
  it.each(Object.entries(FEATURES))("%s show Chinese", (_feature, paths) => {
    const english: string[] = [];
    let checked = 0;
    for (const file of paths.flatMap(filesIn)) {
      const relative = NodePath.relative(root, file);
      const { fork, gt } = sourcesOf(file);
      for (const source of fork) {
        if (ALWAYS_ENGLISH.test(source.split("|").at(-1)!)) continue;
        checked += 1;
        const shown = forkZh.get(source) ?? source;
        if (!HAN.test(shown)) english.push(`${relative}: t(${JSON.stringify(source)})`);
      }
      for (const source of gt) {
        if (ALWAYS_ENGLISH.test(source)) continue;
        checked += 1;
        if (!HAN.test(gtZh.get(source) ?? ""))
          english.push(`${relative}: GT ${JSON.stringify(source)}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(english).toEqual([]);
  });
});
