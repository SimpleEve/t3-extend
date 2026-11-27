// @effect-diagnostics nodeBuiltinImport:off - a plain test that scans the source tree once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { THEME_CSS_HOOKS } from "@t3tools/shared/themeCss";
import { expect, it } from "vite-plus/test";

const sourceDirectory = import.meta.dirname;
const source = NodeFS.readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.(tsx?|css)$/.test(file) && !file.includes(".test."))
  // Preset CSS is a consumer of the hooks, not where they are set: counting it would let a
  // dropped `data-*` attribute pass on its own selector text. Comments name hooks too.
  .filter((file) => !file.startsWith("fork/themeStudio/presetStyles"))
  .map((file) =>
    NodeFS.readFileSync(NodePath.join(sourceDirectory, file), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    ),
  )
  .join("\n");

/** How the selector's hook is written in source: an attribute with its value, a bare attribute, or a class name. */
function sourcePattern(selector: string): RegExp {
  const valued = /^\[(data-[a-z0-9-]+)="([a-z-]+)"\]$/.exec(selector);
  if (valued) return new RegExp(`${valued[1]}["']?\\s*[:=]\\s*["']${valued[2]}["']`);
  const attribute = /^\[(data-[a-z0-9-]+)/.exec(selector)?.[1];
  return new RegExp(`\\b${attribute ?? selector.slice(1)}\\b`);
}

// Theme CSS and the agent guide rely on these selectors. Rename one in the guide too.
it.each(THEME_CSS_HOOKS.map((hook) => hook.selector))(
  "%s is still in the web source",
  (selector) => {
    expect(source).toMatch(sourcePattern(selector));
  },
);
