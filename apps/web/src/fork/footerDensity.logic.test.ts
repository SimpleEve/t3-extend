import { describe, expect, it } from "vite-plus/test";

import {
  type FooterDensity,
  estimateTextWidth,
  footerChipSize,
  resolveFooterLayout,
} from "./footerDensity.logic";

describe("footer density", () => {
  // Priority order: limits, resources, ports. Icon-only is 20px, a gap is 2px.
  const limits = { fullPx: 160, compactPx: 90 };
  const resources = { fullPx: 100, compactPx: 60 };
  const ports = { fullPx: 60, compactPx: 30 };
  const chips = [limits, resources, ports];

  it("upgrades chips by priority: numbers for all first, then full text from the top", () => {
    expect(resolveFooterLayout(Number.POSITIVE_INFINITY, chips)).toEqual(["full", "full", "full"]);
    // Every number is 90 + 60 + 30 + 4 = 184. At 230 limits' full text (+70) does not fit, and
    // upgrading stops there: resources (+40) would fit alone but does not jump the queue.
    expect(resolveFooterLayout(230, chips)).toEqual(["compact", "compact", "compact"]);
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

  it("never shows a chip poorer when the row gets wider", () => {
    const RANK: Record<FooterDensity | "none", number> = { none: 0, icon: 1, compact: 2, full: 3 };
    const labelSets = [
      [
        { full: "Codex 68% · Claude 4%", compact: "Claude 4%" },
        { full: "5% · 388 MB", compact: "388 MB" },
        { full: ":3000 :5173", compact: "2" },
      ],
      [
        { full: "订阅额度 Codex 68% · Claude 4%", compact: "Claude 4%" },
        { full: "5% · 388 MB", compact: "388 MB" },
      ],
      // A full label that is not wider than its compact one still adds nothing, never less.
      [{ full: "1", compact: "Claude 4%" }],
    ].map((labels) => labels.map(footerChipSize));
    for (const sizes of labelSets) {
      let previous = sizes.map(() => 0);
      for (let width = 0; width <= 400; width++) {
        const layout = resolveFooterLayout(width, sizes);
        const ranks = sizes.map((_, index) => RANK[layout[index] ?? "none"]);
        ranks.forEach((rank, index) => expect(rank).toBeGreaterThanOrEqual(previous[index]!));
        previous = ranks;
      }
    }
  });
});
