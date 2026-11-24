import { describe, expect, it } from "vite-plus/test";
import type { ThemeColorRole, ThemeColors } from "@t3tools/shared/themePalettes";

import { getPresetThemes } from "../../themePalette";

// fork: text a preset sets must stay readable (WCAG AA, 4.5:1). The pairs are the ones the app
// paints text on: the page, panels, the sidebar, messages, code, buttons and status chips.
// Terminal is left out: its colors are the ones people already use, copied as they are.

const PAIRS: ReadonlyArray<readonly [ThemeColorRole, ThemeColorRole]> = [
  ["text", "canvas"],
  ["text", "surface"],
  ["text", "surfaceRaised"],
  ["text", "surfaceOverlay"],
  ["textMuted", "canvas"],
  ["textMuted", "surface"],
  ["secondaryLabel", "canvas"],
  ["mutedForeground", "muted"],
  ["placeholder", "surfaceRaised"],
  ["secondaryForeground", "secondary"],
  ["accentForeground", "accent"],
  ["accentSurfaceForeground", "accentSurface"],
  ["messageForeground", "messageSurface"],
  ["messageActionForeground", "messageAction"],
  ["codeForeground", "codeBackground"],
  ["sidebarForeground", "sidebar"],
  ["sidebarMutedForeground", "sidebar"],
  ["sidebarForeground", "sidebarRowActive"],
  ["toolbarForeground", "toolbar"],
  ["toolbarControlForeground", "toolbarControl"],
  ["errorForeground", "errorSurface"],
  ["warningForeground", "warningSurface"],
  ["updateForeground", "updateSurface"],
  ["terminalForeground", "terminalBackground"],
];

function srgbToLinear(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Opaque literals only: `#rrggbb` or `oklch(L C h)` with no alpha, so there is nothing to composite. */
function linearRgb(color: string): readonly [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex) {
    return [0, 2, 4].map((at) =>
      srgbToLinear(Number.parseInt(hex.slice(at, at + 2), 16) / 255),
    ) as [number, number, number];
  }
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(color);
  if (!match) throw new Error(`Not an opaque color literal: ${color}`);
  const [lightness, chroma, hue] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function luminance(color: string): number {
  const [r, g, b] = linearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

// What the sidebar rows paint: thread titles, project names and chrome use the page's text roles
// (not the sidebar* roles), times and icons the muted ones, and the Approval chip the warning one.
// A preset whose sidebar has a different ground than its page sets these again inside
// `[data-slot="sidebar-inner"]`, so what is checked is that scope's value or else the page role.
const SIDEBAR_TEXT: ReadonlyArray<{
  role: ThemeColorRole;
  variable: string;
}> = [
  { role: "text", variable: "--contrast-foreground" },
  { role: "textMuted", variable: "--contrast-muted-foreground" },
  { role: "secondaryLabel", variable: "--contrast-secondary-label" },
  { role: "iconMuted", variable: "--contrast-icon-muted" },
  { role: "warningForeground", variable: "--warning-foreground" },
  { role: "errorForeground", variable: "--error-foreground" },
];

function sidebarScopeVariables(css: string | undefined): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const rule of (css ?? "").replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const open = rule.lastIndexOf("{");
    if (open < 0 || rule.slice(0, open).trim() !== '[data-slot="sidebar-inner"]') continue;
    for (const [, name, value] of rule.slice(open + 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found.set(name!, value!.trim());
    }
  }
  return found;
}

function sidebarFailures(colors: ThemeColors, css: string | undefined): string[] {
  const scope = sidebarScopeVariables(css);
  return SIDEBAR_TEXT.flatMap(({ role, variable }) => {
    const color = scope.get(variable) ?? colors[role];
    const ratio = contrast(color, colors.sidebar);
    // Icons are graphics, not text: WCAG asks 3:1 of them.
    return ratio >= (role === "iconMuted" ? 3 : 4.5)
      ? []
      : [`${role} on sidebar: ${ratio.toFixed(2)}`];
  });
}

function failures(colors: ThemeColors): string[] {
  return PAIRS.flatMap(([fg, bg]) => {
    const ratio = contrast(colors[fg], colors[bg]);
    return ratio >= 4.5 ? [] : [`${fg} on ${bg}: ${ratio.toFixed(2)}`];
  });
}

const CASES = getPresetThemes()
  .filter((theme) => theme.id !== "studio-terminal")
  .flatMap((preset) =>
    (
      [
        [preset.appearance, preset.colors],
        ...Object.entries(preset.variants ?? {}),
      ] as ReadonlyArray<readonly [string, ThemeColors]>
    ).map(([appearance, colors]) => ({
      name: `${preset.id} (${appearance})`,
      colors,
      css: preset.css,
    })),
  );

describe("preset colors", () => {
  it.each(CASES)("$name keeps its text readable", ({ colors }) => {
    expect(failures(colors)).toEqual([]);
  });

  it.each(CASES)("$name keeps the sidebar rows readable on the sidebar", ({ colors, css }) => {
    expect(sidebarFailures(colors, css)).toEqual([]);
  });
});
