import { THEME_CSS_MAX_LENGTH } from "@t3tools/contracts";
import { themeCssLoadsRemoteFiles } from "@t3tools/shared/themeCss";
import { describe, expect, it } from "vite-plus/test";

import { getPresetThemes } from "../../themePalette";

// fork: what every preset's CSS must keep true. The client drops a declaration whose value has a
// backslash or fetches, so text goes in as the character itself, and a preset that adds words to
// the chat has to say them in the interface language: Chinese text only under `:lang(zh)`.

const CASES = getPresetThemes()
  .filter((preset) => preset.css !== undefined)
  .map((preset) => ({ id: preset.id, css: preset.css ?? "" }));

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

describe("preset css", () => {
  it.each(CASES)("$id loads nothing, has no backslash, and stays within the limit", ({ css }) => {
    expect(themeCssLoadsRemoteFiles(css)).toBe(false);
    expect(css).not.toContain("\\");
    expect(css.length).toBeLessThan(THEME_CSS_MAX_LENGTH);
  });

  it.each(CASES)("$id has no animation or transition", ({ css }) => {
    expect(css).not.toMatch(/@keyframes|animation\s*:|transition\s*:/);
  });

  it.each(CASES)("$id says Chinese text only under :lang(zh)", ({ css }) => {
    const stray = rules(css)
      .filter(
        ({ body }) =>
          /content\s*:[^;]*/.test(body) && CJK.test(/content\s*:[^;]*/.exec(body)?.[0] ?? ""),
      )
      .filter(({ selector }) => !selector.startsWith(":lang(zh)"))
      .map(({ selector }) => selector);
    expect(stray).toEqual([]);
  });
});
