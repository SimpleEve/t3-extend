import type { ThemeLook } from "@t3tools/contracts";
import { themeLooksEqual, withThemeLookValue } from "@t3tools/shared/forkThemeLook";
import type { ThemeAppearance, ThemeColors, ThemeDefinition } from "@t3tools/shared/themePalettes";

// fork: the theme studio's rules, kept out of the UI. A scheme is a ThemeDefinition in the custom
// theme library; a preset is never edited. Editing a preset forks it into a scheme that remembers
// the preset (`basedOn`), so it can go back.

const MAX_ID_LENGTH = 48;
const MAX_LABEL_LENGTH = 48;
const FORK_SUFFIX = "-mine";

function uniqueName(base: string, taken: ReadonlySet<string>, join: (n: number) => string): string {
  if (!taken.has(base)) return base;
  for (let attempt = 2; ; attempt += 1) {
    const candidate = join(attempt);
    if (!taken.has(candidate)) return candidate;
  }
}

function forkId(baseId: string, takenIds: ReadonlySet<string>): string {
  const room = (suffix: string) => baseId.slice(0, MAX_ID_LENGTH - suffix.length) + suffix;
  return uniqueName(room(FORK_SUFFIX), takenIds, (attempt) => room(`${FORK_SUFFIX}-${attempt}`));
}

function forkLabel(label: string, takenLabels: ReadonlySet<string>): string {
  const fit = (text: string) =>
    text.length <= MAX_LABEL_LENGTH ? text : `${text.slice(0, MAX_LABEL_LENGTH - 1)}…`;
  return uniqueName(fit(label), takenLabels, (attempt) => fit(`${label} ${attempt}`));
}

/**
 * What an edit changes. A saved scheme is edited in place; a preset, a built-in or a published
 * theme forks into a new scheme named by `mineLabel`, so the original never changes.
 * `restorable` says the base can be found again by id. `forceFork` copies a saved scheme too.
 */
export function beginScheme(input: {
  base: ThemeDefinition;
  savedThemes: ReadonlyArray<ThemeDefinition>;
  mineLabel: string;
  restorable: boolean;
  forceFork?: boolean;
}): ThemeDefinition {
  const { base, savedThemes, mineLabel, restorable } = input;
  const isSaved = savedThemes.some((theme) => theme.id === base.id);
  if (isSaved && input.forceFork !== true) return base;
  const forked: { -readonly [K in keyof ThemeDefinition]: ThemeDefinition[K] } = {
    id: forkId(base.id, new Set(savedThemes.map((theme) => theme.id))),
    label: forkLabel(mineLabel, new Set(savedThemes.map((theme) => theme.label))),
    appearance: base.appearance,
    colors: base.colors,
  };
  if (base.variants) forked.variants = base.variants;
  if (base.css) forked.css = base.css;
  if (base.look) forked.look = base.look;
  // A copy of a saved scheme goes back to the same preset its original does.
  const origin = isSaved ? base.basedOn : restorable ? base.id : undefined;
  if (origin) forked.basedOn = origin;
  return forked;
}

export function schemeColors(
  scheme: ThemeDefinition,
  appearance: ThemeAppearance,
): ThemeColors | null {
  if (appearance === scheme.appearance) return scheme.colors;
  return scheme.variants?.[appearance] ?? null;
}

/** The appearance an edit lands in: the one on screen, or the scheme's own when it has no such palette. */
export function editableAppearance(
  scheme: ThemeDefinition,
  shown: ThemeAppearance,
): ThemeAppearance {
  return schemeColors(scheme, shown) ? shown : scheme.appearance;
}

export function withSchemeColors(
  scheme: ThemeDefinition,
  appearance: ThemeAppearance,
  colors: ThemeColors,
): ThemeDefinition {
  if (appearance === scheme.appearance) return { ...scheme, colors };
  return { ...scheme, variants: { ...scheme.variants, [appearance]: colors } };
}

export function withSchemeLook<K extends keyof ThemeLook>(
  scheme: ThemeDefinition,
  key: K,
  value: ThemeLook[K] | undefined,
): ThemeDefinition {
  const look = withThemeLookValue(scheme.look, key, value);
  const { look: _previous, ...rest } = scheme;
  return look ? { ...rest, look } : rest;
}

export function withSchemeCss(scheme: ThemeDefinition, css: string): ThemeDefinition {
  const { css: _previous, ...rest } = scheme;
  return css.trim() ? { ...rest, css } : rest;
}

/** Puts a scheme's colors, CSS and look back to the preset it came from. The name and id stay. */
export function restoreSchemeToPreset(
  scheme: ThemeDefinition,
  preset: ThemeDefinition,
): ThemeDefinition {
  const { variants: _v, css: _c, look: _l, ...rest } = scheme;
  return {
    ...rest,
    appearance: preset.appearance,
    colors: preset.colors,
    ...(preset.variants ? { variants: preset.variants } : {}),
    ...(preset.css ? { css: preset.css } : {}),
    ...(preset.look ? { look: preset.look } : {}),
  };
}

function colorsEqual(a: ThemeColors | undefined, b: ThemeColors | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (Object.keys(a) as Array<keyof ThemeColors>).every((role) => a[role] === b[role]);
}

/** Whether two definitions look the same. The name and id are not part of the look. */
export function sameAppearanceOf(a: ThemeDefinition, b: ThemeDefinition): boolean {
  return (
    a.appearance === b.appearance &&
    colorsEqual(a.colors, b.colors) &&
    colorsEqual(a.variants?.light, b.variants?.light) &&
    colorsEqual(a.variants?.dark, b.variants?.dark) &&
    (a.css ?? "") === (b.css ?? "") &&
    themeLooksEqual(a.look, b.look)
  );
}

/**
 * Whether the draft has anything to save. A saved scheme is compared with its stored copy, name
 * included. A fork nobody saved yet is compared with what it was forked from: a fork that was
 * edited back to the original has nothing to save.
 */
export function hasUnsavedChanges(
  draft: ThemeDefinition | null,
  saved: ThemeDefinition | null,
  origin: ThemeDefinition,
): boolean {
  if (draft === null) return false;
  if (saved) return draft.label !== saved.label || !sameAppearanceOf(draft, saved);
  return !sameAppearanceOf(draft, origin);
}

export type LookSetting = "fontUi" | "fontCode" | "chatWidth";

/** Which of the user's own settings a theme's look overrides right now. */
export function overriddenSettings(look: ThemeLook | undefined): ReadonlyArray<LookSetting> {
  const keys: ReadonlyArray<LookSetting> = ["fontUi", "fontCode", "chatWidth"];
  return keys.filter((key) => look?.[key] !== undefined);
}

type ThemeHalvesRaw = Readonly<{ light?: string; dark?: string }>;

/**
 * Where a theme the studio just made or opened goes. With light and dark set apart it takes only
 * the half in use, so the other half survives; only a person choosing a whole theme replaces both.
 */
export function placeTheme(
  halves: ThemeHalvesRaw,
  appearance: ThemeAppearance,
  themeId: string,
):
  | { readonly kind: "half"; readonly appearance: ThemeAppearance; readonly themeId: string }
  | { readonly kind: "whole"; readonly themeId: string } {
  return halves.light !== undefined || halves.dark !== undefined
    ? { kind: "half", appearance, themeId }
    : { kind: "whole", themeId };
}

/** The halves left after a theme is deleted. */
export function halvesWithout(halves: ThemeHalvesRaw, themeId: string): ThemeHalvesRaw {
  return {
    ...(halves.light !== undefined && halves.light !== themeId ? { light: halves.light } : {}),
    ...(halves.dark !== undefined && halves.dark !== themeId ? { dark: halves.dark } : {}),
  };
}
