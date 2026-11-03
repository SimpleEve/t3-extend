import { describe, expect, it } from "vite-plus/test";

import { maxIconChips, resolveFooterDensity } from "./footerDensity.logic";

describe("footer density", () => {
  const chips = [
    { fullChars: 10, compactChars: 3 },
    { fullChars: 12, compactChars: 4 },
  ];

  it("keeps the richest density that fits every chip and falls back to the icon", () => {
    expect(resolveFooterDensity(Number.POSITIVE_INFINITY, chips)).toBe("full");
    expect(resolveFooterDensity(120, chips)).toBe("compact");
    expect(resolveFooterDensity(10, chips)).toBe("icon");
  });

  it("counts whole icon chips only", () => {
    expect(maxIconChips(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(maxIconChips(64)).toBe(3);
    expect(maxIconChips(47)).toBe(2);
    expect(maxIconChips(5)).toBe(0);
  });
});
