export type FooterDensity = "full" | "compact" | "icon";

/** What one chip needs in pixels at each density; the icon alone is always `ICON_CHIP_PX`. */
export interface FooterChipSize {
  readonly fullPx: number;
  readonly compactPx: number;
}

// Measured on the 11px label: a chip is its text plus 24px of icon and padding (2px more here as
// slack, so a label never clips), and an icon-only chip is 20px.
const CHIP_CHROME_PX = 26;
const ICON_CHIP_PX = 20;
const DIGIT_PX = 7.2;
const LATIN_CHAR_PX = 6.4;
const WIDE_CHAR_PX = 12;
const CHIP_GAP_PX = 2;

// CJK ideographs, kana, Hangul, and full-width forms are about twice as wide as Latin text.
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60]/u;

export function estimateTextWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += WIDE_CHAR.test(char) ? WIDE_CHAR_PX : /\d/.test(char) ? DIGIT_PX : LATIN_CHAR_PX;
  }
  return Math.ceil(width);
}

export function footerChipSize(labels: {
  readonly full: string;
  readonly compact: string;
}): FooterChipSize {
  return {
    fullPx: CHIP_CHROME_PX + estimateTextWidth(labels.full),
    compactPx: CHIP_CHROME_PX + estimateTextWidth(labels.compact),
  };
}

function widthAt(size: FooterChipSize, density: FooterDensity): number {
  return density === "full" ? size.fullPx : density === "compact" ? size.compactPx : ICON_CHIP_PX;
}

function rowWidth(sizes: readonly FooterChipSize[], densities: readonly FooterDensity[]): number {
  return (
    densities.reduce((sum, density, index) => sum + widthAt(sizes[index]!, density), 0) +
    Math.max(0, densities.length - 1) * CHIP_GAP_PX
  );
}

/**
 * How each chip is drawn in `available` pixels; `chips` is in priority order, highest first.
 * Chips that cannot even show their icon are dropped from the end. Of those that stay, each gets
 * its icon and number in priority order, then each is upgraded to its full text in the same order,
 * so a narrow row keeps the numbers of the chips that matter most.
 */
export function resolveFooterLayout(
  available: number,
  chips: readonly FooterChipSize[],
): readonly FooterDensity[] {
  let visible = chips.length;
  while (visible > 0 && rowWidth(chips, Array<FooterDensity>(visible).fill("icon")) > available) {
    visible -= 1;
  }
  const shown = chips.slice(0, visible);
  const densities = Array<FooterDensity>(visible).fill("icon");
  for (const target of ["compact", "full"] as const) {
    for (let index = 0; index < visible; index++) {
      const before = densities[index]!;
      densities[index] = target;
      if (rowWidth(shown, densities) > available) densities[index] = before;
    }
  }
  return densities;
}
