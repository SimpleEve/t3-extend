import { describe, expect, it } from "vite-plus/test";

import { resolveFooterDensity } from "./footerDensity.logic";

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
});
