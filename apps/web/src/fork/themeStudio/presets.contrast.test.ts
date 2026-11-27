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

function contrast(foreground: string, background: string, alpha = 1): number {
  const bg = linearRgb(background);
  // Alpha composites on the gamma-encoded values, as the browser does.
  const encode = (value: number) =>
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  const mixed = linearRgb(foreground).map((channel, at) =>
    srgbToLinear(alpha * encode(channel) + (1 - alpha) * encode(bg[at]!)),
  ) as [number, number, number];
  const lum = ([r, g, b]: readonly [number, number, number]) =>
    0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [light, dark] = [lum(mixed), lum(bg)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

// Sidebar rows paint the page's text roles, so a preset with a different sidebar ground sets them
// again in `[data-slot="sidebar-inner"]` (or that scope under `:root.dark` / `:root:not(.dark)`).
// The ground checked is `colors.sidebar`; other scopes are not read.
const SIDEBAR_TEXT: ReadonlyArray<{
  role: ThemeColorRole;
  variable: string;
}> = [
  { role: "text", variable: "--contrast-foreground" },
  { role: "textMuted", variable: "--contrast-muted-foreground" },
  { role: "secondaryLabel", variable: "--contrast-secondary-label" },
  { role: "iconMuted", variable: "--contrast-icon-muted" },
  { role: "placeholder", variable: "--contrast-placeholder" },
  { role: "warningForeground", variable: "--warning-foreground" },
  { role: "errorForeground", variable: "--error-foreground" },
];

// The wordmark is the accent on the sidebar; as a logo it needs 3:1, not 4.5:1.
const WORDMARK = { role: "accent", variable: "--primary" } as const;

// The app dims some text: thread titles are the text color at 75% on the sidebar, the rows of the
// details panel at 80% on a panel.
const DIMMED: ReadonlyArray<{
  role: ThemeColorRole;
  variable: string;
  ground: ThemeColorRole;
  alpha: number;
}> = [
  { role: "text", variable: "--contrast-foreground", ground: "sidebar", alpha: 0.75 },
  { role: "text", variable: "--contrast-foreground", ground: "surfaceOverlay", alpha: 0.8 },
];

const ROW_GROUNDS = ["sidebarRowHover", "sidebarRowActive", "sidebarRowSelected"] as const;
const ROW_TEXT: ReadonlyArray<{ role: ThemeColorRole; variable?: string }> = [
  { role: "sidebarForeground" },
  { role: "sidebarMutedForeground" },
  { role: "secondaryLabel", variable: "--contrast-secondary-label" },
];

/** Whether the preset paints the open row's text itself, so the palette's row colors do not apply. */
function paintsOpenRowText(css: string | undefined): boolean {
  return /\[aria-current="page"\]\s*\*[^{]*\{[^}]*\bcolor\s*:/.test(css ?? "");
}

const SCOPE = /^(?::root(\.dark|:not\(\.dark\)))?\s*\[data-slot="sidebar-inner"\]$/;

/** The variables the sidebar scope sets for one half; a `:root.dark` or `:root:not(.dark)` rule counts for its half only. */
function sidebarScopeVariables(
  css: string | undefined,
  appearance: string,
): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const rule of (css ?? "").replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const open = rule.lastIndexOf("{");
    const half = open < 0 ? null : SCOPE.exec(rule.slice(0, open).trim());
    if (!half) continue;
    if (half[1] !== undefined && (half[1] === ".dark") !== (appearance === "dark")) continue;
    for (const [, name, value] of rule.slice(open + 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found.set(name!, value!.trim());
    }
  }
  return found;
}

function sidebarFailures(
  colors: ThemeColors,
  css: string | undefined,
  appearance: string,
): string[] {
  const scope = sidebarScopeVariables(css, appearance);
  const onSidebar = SIDEBAR_TEXT.flatMap(({ role, variable }) => {
    const color = scope.get(variable) ?? colors[role];
    const ratio = contrast(color, colors.sidebar);
    // Icons are graphics, not text: WCAG asks 3:1 of them.
    return ratio >= (role === "iconMuted" ? 3 : 4.5)
      ? []
      : [`${role} on sidebar: ${ratio.toFixed(2)}`];
  });
  const wordmark = contrast(scope.get(WORDMARK.variable) ?? colors.accent, colors.sidebar);
  const dimmed = DIMMED.flatMap(({ role, variable, ground, alpha }) => {
    // The sidebar's own scope only applies on the sidebar.
    const color = (ground === "sidebar" ? scope.get(variable) : undefined) ?? colors[role];
    const ratio = contrast(color, colors[ground], alpha);
    return ratio >= 4.5 ? [] : [`${role} at ${alpha * 100}% on ${ground}: ${ratio.toFixed(2)}`];
  });
  const painted = paintsOpenRowText(css);
  const onRows = ROW_GROUNDS.flatMap((ground) =>
    painted && ground !== "sidebarRowHover"
      ? []
      : ROW_TEXT.flatMap(({ role, variable }) => {
          const ratio = contrast((variable && scope.get(variable)) || colors[role], colors[ground]);
          return ratio >= 4.5 ? [] : [`${role} on ${ground}: ${ratio.toFixed(2)}`];
        }),
  );
  return [
    ...onSidebar,
    ...(wordmark >= 3 ? [] : [`wordmark on sidebar: ${wordmark.toFixed(2)}`]),
    ...dimmed,
    ...onRows,
  ];
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
      appearance,
      colors,
      css: preset.css,
    })),
  );

// A preset can paint a ground of its own, as omp's tool cards do, and the row keeps painting the
// palette's text roles on it. Those have to stay readable on the preset's ground too.
const TOOL_CARD_TEXT: ReadonlyArray<ThemeColorRole> = ["text", "textMuted", "secondaryLabel"];

/** Custom properties of `:root` for one half, in cascade order. */
function rootVariables(css: string | undefined, appearance: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const rule of (css ?? "").replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const open = rule.lastIndexOf("{");
    if (open < 0) continue;
    const selector = rule.slice(0, open).trim();
    if (
      selector !== ":root" &&
      !(selector === ":root.dark" && appearance === "dark") &&
      !(selector === ":root:not(.dark)" && appearance === "light")
    ) {
      continue;
    }
    for (const [, name, value] of rule.slice(open + 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found.set(name!, value!.trim());
    }
  }
  return found;
}

/** The grounds a preset paints on its tool rows: the `background` of a `[data-tool-status]` rule. */
function toolCardGrounds(css: string | undefined): ReadonlyArray<string> {
  const grounds = new Set<string>();
  for (const rule of (css ?? "").replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const open = rule.lastIndexOf("{");
    if (open < 0 || !rule.slice(0, open).includes("[data-tool-status")) continue;
    const ground = /(?:^|[\s;])background(?:-color)?\s*:\s*var\((--[\w-]+)\)/.exec(
      rule.slice(open + 1),
    )?.[1];
    if (ground !== undefined) grounds.add(ground);
  }
  return [...grounds];
}

const TOOL_CARD_CASES = CASES.flatMap(({ name, appearance, colors, css }) => {
  const variables = rootVariables(css, appearance);
  return toolCardGrounds(css).map((variable) => ({
    name: `${name} on ${variable}`,
    ground: variables.get(variable),
    colors,
  }));
});

describe("preset colors", () => {
  it.each(CASES)("$name keeps its text readable", ({ colors }) => {
    expect(failures(colors)).toEqual([]);
  });

  it.each(TOOL_CARD_CASES)("$name keeps the tool card's text readable", ({ colors, ground }) => {
    expect(ground).toBeDefined();
    const unreadable = TOOL_CARD_TEXT.flatMap((role) => {
      const ratio = contrast(colors[role], ground!);
      return ratio >= 4.5 ? [] : [`${role} on ${ground}: ${ratio.toFixed(2)}`];
    });
    expect(unreadable).toEqual([]);
  });

  it.each(CASES)(
    "$name keeps the sidebar rows readable on the sidebar",
    ({ colors, css, appearance }) => {
      expect(sidebarFailures(colors, css, appearance)).toEqual([]);
    },
  );
});
