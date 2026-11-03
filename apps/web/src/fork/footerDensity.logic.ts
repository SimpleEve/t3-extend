export type FooterDensity = "full" | "compact" | "icon";

/** What one chip prints at each density, in characters; the icon is always there. */
export interface FooterChipSize {
  readonly fullChars: number;
  readonly compactChars: number;
}

// 11px text in a micro button: horizontal padding plus the 12px icon, then the label.
const CHIP_CHROME_PX = 24;
const CHAR_PX = 6.4;
const CHIP_GAP_PX = 2;

function chipWidth(size: FooterChipSize, density: FooterDensity): number {
  if (density === "icon") return CHIP_CHROME_PX - 4;
  const chars = density === "full" ? size.fullChars : size.compactChars;
  return CHIP_CHROME_PX + Math.ceil(chars * CHAR_PX);
}

/**
 * The richest density at which every chip fits in `available` pixels. Icon-only is the floor: it
 * is what is left when nothing else fits, and the details live in each chip's panel.
 */
export function resolveFooterDensity(
  available: number,
  chips: readonly FooterChipSize[],
): FooterDensity {
  for (const density of ["full", "compact"] as const) {
    const needed =
      chips.reduce((sum, chip) => sum + chipWidth(chip, density), 0) +
      Math.max(0, chips.length - 1) * CHIP_GAP_PX;
    if (needed <= available) return density;
  }
  return "icon";
}
