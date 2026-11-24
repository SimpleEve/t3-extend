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

const FORK_ID_SUFFIX = /-mine(?:-\d+)?$/;

/**
 * A copy of a scheme under a name the person chose. It gets its own id and a name no other scheme
 * has, and remembers the same preset, so several versions of one preset sit side by side and
 * saving one never writes over another. `scheme` is the draft, a saved scheme or a preset's fork.
 */
export function schemeCopyOf(input: {
  scheme: ThemeDefinition;
  name: string;
  savedThemes: ReadonlyArray<ThemeDefinition>;
}): ThemeDefinition {
  const { scheme, savedThemes } = input;
  return {
    ...scheme,
    id: forkId(
      scheme.id.replace(FORK_ID_SUFFIX, ""),
      new Set(savedThemes.map((saved) => saved.id)),
    ),
    label: forkLabel(
      input.name.trim() || scheme.label,
      new Set(savedThemes.map((saved) => saved.label)),
    ),
  };
}

/** The saved versions made from a preset, for the hint on its card. */
export function schemesBasedOn(
  presetId: string,
  savedThemes: ReadonlyArray<ThemeDefinition>,
): ReadonlyArray<ThemeDefinition> {
  return savedThemes.filter(
    (saved) => saved.basedOn === presetId && saved.collection === undefined,
  );
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

/** The id the theme library's stock card sends: the stock theme has no definition to look up. */
export const STOCK_THEME_ID = "t3-code";

/**
 * The theme a Duplicate, Create or Edit starts from. `themeId` names one (the stock card names
 * the stock theme); none means the theme in use. Only a theme that can be found again by id can
 * be restored to.
 */
export function studioOrigin(input: {
  themeId: string | null;
  find: (themeId: string) => ThemeDefinition | null;
  applied: ThemeDefinition | null;
  stock: ThemeDefinition;
}): { readonly origin: ThemeDefinition; readonly restorable: boolean } {
  if (input.themeId === STOCK_THEME_ID) return { origin: input.stock, restorable: false };
  const named = input.themeId === null ? null : input.find(input.themeId);
  const origin = named ?? input.applied;
  return origin === null
    ? { origin: input.stock, restorable: false }
    : { origin, restorable: true };
}

/**
 * The theme a scheme's `basedOn` names, or null. A saved theme is never one: an imported theme
 * can reuse the id of a retired preset, and "Restore to preset" must not take it for the base.
 */
export function schemeBase(
  basedOn: string | undefined,
  find: (themeId: string) => ThemeDefinition | null,
  savedThemes: ReadonlyArray<ThemeDefinition>,
): ThemeDefinition | null {
  if (basedOn === undefined || savedThemes.some((saved) => saved.id === basedOn)) return null;
  return find(basedOn);
}

export type StudioThemeKind = "default" | "preset" | "builtIn" | "scheme" | "published";

/** What the header calls the theme being edited. Only a theme a server publishes is "published". */
export function studioThemeKind(input: {
  id: string;
  stock: boolean;
  presetIds: ReadonlySet<string>;
  builtInIds: ReadonlySet<string>;
  savedIds: ReadonlySet<string>;
}): StudioThemeKind {
  if (input.stock) return "default";
  if (input.presetIds.has(input.id)) return "preset";
  if (input.builtInIds.has(input.id)) return "builtIn";
  return input.savedIds.has(input.id) ? "scheme" : "published";
}
