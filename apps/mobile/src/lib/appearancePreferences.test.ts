import { describe, expect, it } from "vite-plus/test";

import { resolveAppearancePreferences, resolveTextScaleVariables } from "./appearancePreferences";

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
});
