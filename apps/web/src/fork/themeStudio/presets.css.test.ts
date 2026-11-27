import { THEME_CSS_MAX_LENGTH } from "@t3tools/contracts";
import { THEME_CSS_HOOKS, themeCssLoadsRemoteFiles } from "@t3tools/shared/themeCss";
import { describe, expect, it } from "vite-plus/test";

import { getPresetThemes } from "../../themePalette";

// fork: what every preset's CSS must keep true. The client drops a declaration whose value has a
// backslash or fetches, so text goes in as the character itself, and a preset that adds words to
// the chat has to say them in the interface language: Chinese text only under `:lang(zh)`.
// Terminal is the user's own CSS, copied as it was; the selector rules are for the others.

const ALL = getPresetThemes()
  .filter((preset) => preset.css !== undefined)
  .map((preset) => ({ id: preset.id, css: preset.css ?? "" }));
const CASES = ALL.filter((preset) => preset.id !== "studio-terminal");

const CJK = /[㐀-鿿＀-￯―]/;

function rules(css: string): Array<{ selector: string; body: string }> {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .flatMap((chunk) => {
      const open = chunk.lastIndexOf("{");
      if (open < 0) return [];
      return [{ selector: chunk.slice(0, open).trim(), body: chunk.slice(open + 1) }];
    });
}

/** Selectors of one rule, split on commas outside parentheses. */
function selectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of list) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== "");
}

// What the guide registers: `data-slot` values, other data attributes (with a value when the guide
// gives one) and class names.
const HOOKS = THEME_CSS_HOOKS.map((hook) => {
  const attribute = /^\[(data-[a-z0-9-]+)(?:="([^"]*)")?\]$/.exec(hook.selector);
  return {
    attribute: attribute?.[1],
    value: attribute?.[2],
    className: hook.selector.startsWith(".") ? hook.selector.slice(1) : undefined,
  };
});
const ALLOWED_CLASSES = new Set([
  ...HOOKS.flatMap((hook) => (hook.className ? [hook.className] : [])),
  "dark",
  "lucide",
]);

function unregistered(selector: string): string[] {
  const found: string[] = [];
  for (const [, name, value] of selector.matchAll(/\[(data-[a-z0-9-]+)(?:="([^"]*)")?\]/g)) {
    const known = HOOKS.some(
      (hook) =>
        hook.attribute === name &&
        (hook.value === undefined ? name !== "data-slot" : hook.value === value),
    );
    if (!known) found.push(value === undefined ? `[${name}]` : `[${name}="${value}"]`);
  }
  const withoutAttributes = selector.replace(/\[[^\]]*\]/g, "").replace(/:lang\([^)]*\)/g, "");
  for (const [, className] of withoutAttributes.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
    if (!ALLOWED_CLASSES.has(className ?? "")) found.push(`.${className}`);
  }
  return found;
}

describe("preset css", () => {
  it.each(ALL)("$id loads nothing, has no backslash, and stays within the limit", ({ css }) => {
    expect(themeCssLoadsRemoteFiles(css)).toBe(false);
    expect(css).not.toContain("\\");
    expect(css.length).toBeLessThanOrEqual(THEME_CSS_MAX_LENGTH);
  });

  it.each(ALL)("$id has no animation or transition", ({ css }) => {
    expect(css).not.toMatch(/@keyframes|animation\s*:|transition\s*:/);
  });

  it.each(ALL)("$id says Chinese text only under :lang(zh)", ({ css }) => {
    const stray = rules(css)
      .filter(
        ({ body }) =>
          /content\s*:[^;]*/.test(body) && CJK.test(/content\s*:[^;]*/.exec(body)?.[0] ?? ""),
      )
      .filter(({ selector }) => !selector.startsWith(":lang(zh)"))
      .map(({ selector }) => selector);
    expect(stray).toEqual([]);
  });

  it.each(CASES)("$id gives added text an empty accessible name", ({ css }) => {
    const bare = rules(css)
      .filter(({ body }) => /(^|;)\s*content\s*:\s*[^;]*[("]/.test(body))
      .filter(({ body }) => !/content\s*:[^;]*\/\s*""/.test(body))
      .map(({ selector }) => selector);
    expect(bare).toEqual([]);
  });

  it.each(CASES)("$id starts every selector at a registered hook", ({ css }) => {
    const bad = rules(css)
      .flatMap(({ selector }) => selectors(selector))
      .filter((selector) => {
        // `:root` carries variables, `:lang()` picks the language; the selector goes on from there.
        const first = selector.replace(/^(:lang\([^)]*\)\s+)/, "");
        if (/^(:root|\[data-|\.[a-zA-Z]|svg\.lucide)/.test(first)) return false;
        return true;
      });
    expect(bad).toEqual([]);
  });

  it.each(CASES)("$id relies on no DOM order, and only registered data attributes", ({ css }) => {
    const found = rules(css).flatMap(({ selector }) =>
      selectors(selector).flatMap((one) => {
        const withoutStrings = one.replace(/"[^"]*"/g, '""');
        const order = /[>+~]|:nth-|:last-child/.test(withoutStrings) ? [`order: ${one}`] : [];
        return [...order, ...unregistered(one)];
      }),
    );
    expect(found).toEqual([]);
  });
});
