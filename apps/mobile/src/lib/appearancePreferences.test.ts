import { describe, expect, it } from "vite-plus/test";

import {
  resolveAppearancePreferences,
  resolveComposerTextRole,
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
  resolveTextScaleVariables,
} from "./appearancePreferences";

describe("appearancePreferences", () => {
  it("migrates the legacy markdownFontSize key to baseFontSize", () => {
    expect(resolveAppearancePreferences({ markdownFontSize: 18 }).baseFontSize).toBe(18);
    expect(
      resolveAppearancePreferences({ baseFontSize: 16, markdownFontSize: 18 }).baseFontSize,
    ).toBe(16);
  });

  it("sizes text for the language, keeping English at the upstream whole points", () => {
    const en = resolveTextScaleVariables(16, "en");
    expect(en["--text-base"]).toBe(16);
    expect(en["--text-sm"]).toBe(14);
    expect(resolveTextScaleVariables(18, "en")["--text-sm"]).toBe(16);

    const zh = resolveTextScaleVariables(16, "zh-Hans");
    expect(zh["--text-base"]).toBe(15);
    expect(zh["--text-sm"]).toBe(13);
    expect(zh["--text-3xs"]).toBeGreaterThanOrEqual(11.5);
    expect(zh["--text-sm--line-height"]).toBe(en["--text-sm--line-height"]);
    expect(resolveTextScaleVariables(18, "zh-Hans")["--text-base"]).toBe(17);
  });

  it("sizes chat Markdown for the language and leaves code blocks on their own size", () => {
    const en = resolveMarkdownFontSizes(16, "en");
    expect([en.m, en.h1, en.h2, en.h3, en.h4]).toEqual([16, 21, 19, 17, 15]);

    const zh = resolveMarkdownFontSizes(16, "zh-Hans");
    expect([zh.m, zh.s, zh.h1, zh.h2, zh.h3, zh.h4]).toEqual([15, 13, 20, 18, 16, 14]);
    expect(zh.codeBlockFontSize).toBe(en.codeBlockFontSize);
    expect(zh.bodyLineHeight).toBe(en.bodyLineHeight);

    expect(resolveMarkdownFontSizes(18, "zh-Hans").m).toBe(17);
    expect(resolveNativeMarkdownTypography(16, "zh-Hans").fontSize).toBe(15);
    expect(resolveNativeMarkdownTypography(16, "en").fontSize).toBe(16);
  });

  it("scales the iOS composer text with the system text size", () => {
    const body = { fontSize: 16, lineHeight: 23 };
    expect(resolveComposerTextRole(body, 1, "ios")).toEqual(body);
    expect(resolveComposerTextRole(body, 2.643, "ios")).toEqual({
      fontSize: 16 * 2.643,
      lineHeight: 23 * 2.643,
    });
    expect(resolveComposerTextRole(body, 2.643, "android")).toEqual(body);
  });
});
