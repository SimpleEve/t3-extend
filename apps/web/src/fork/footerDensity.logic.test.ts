import { describe, expect, it } from "vite-plus/test";

import { estimateTextWidth, footerChipSize, resolveFooterLayout } from "./footerDensity.logic";

describe("footer density", () => {
  // Priority order: limits, resources, ports. Icon-only is 20px, a gap is 2px.
  const limits = { fullPx: 160, compactPx: 90 };
  const resources = { fullPx: 100, compactPx: 60 };
  const ports = { fullPx: 60, compactPx: 30 };
  const chips = [limits, resources, ports];

  it("upgrades chips by priority: numbers for all first, then full text from the top", () => {
    expect(resolveFooterLayout(Number.POSITIVE_INFINITY, chips)).toEqual(["full", "full", "full"]);
    // Every number is 90 + 60 + 30 + 4 = 184. At 230 limits' full text (+70) does not fit but
    // resources' (+40) does; ports' (+30) then no longer fits.
    expect(resolveFooterLayout(230, chips)).toEqual(["compact", "full", "compact"]);
    expect(resolveFooterLayout(184, chips)).toEqual(["compact", "compact", "compact"]);
  });

  it("gives the numbers to the higher priorities when they do not all fit, then drops from the end", () => {
    // Limits and resources as numbers, ports as an icon: 90 + 60 + 20 + 4.
    expect(resolveFooterLayout(174, chips)).toEqual(["compact", "compact", "icon"]);
    expect(resolveFooterLayout(140, chips)).toEqual(["compact", "icon", "icon"]);
    // Three icons need 64px; below that the last chips are dropped whole.
    expect(resolveFooterLayout(63, chips)).toEqual(["icon", "icon"]);
    expect(resolveFooterLayout(19, chips)).toEqual([]);
  });

  it("counts Chinese characters at twice the width of Latin ones", () => {
    expect(estimateTextWidth("abcd")).toBe(26);
    expect(estimateTextWidth("12")).toBe(15);
    expect(estimateTextWidth("订阅额度")).toBe(48);
    expect(footerChipSize({ full: "订阅额度", compact: "ab" })).toEqual({
      fullPx: 74,
      compactPx: 39,
    });
  });
});
