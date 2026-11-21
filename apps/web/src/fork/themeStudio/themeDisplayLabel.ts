import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

import { getPresetThemes, type ThemeDefinition } from "../../themePalette";

// fork: kept apart from the studio hook so the command palette and the theme library can name a
// theme without loading the studio.

type Translate = (text: string, params?: Readonly<Record<string, string | number>>) => string;

const isOwnTheme = (id: string) =>
  getPresetThemes().some((preset) => preset.id === id) ||
  BUILT_IN_THEMES.some((builtIn) => builtIn.id === id);

// What `uniqueName` makes of "{name} (mine)": the suffix, then an optional counter.
const MINE_SUFFIX = /^(.+) \(mine\)( \d+)?$/;

/**
 * Our own presets and the built-in themes have translated names; a person's schemes do not, except
 * the "(mine)" the studio added when it made them. That was written in the language of the day, so
 * a scheme made in English shows the suffix in the current language.
 */
export function themeDisplayLabel(definition: ThemeDefinition, t: Translate): string {
  if (isOwnTheme(definition.id)) return t(definition.label);
  const mine = MINE_SUFFIX.exec(definition.label);
  if (mine === null) return definition.label;
  const [, name = "", counter = ""] = mine;
  const preset = [...getPresetThemes(), ...BUILT_IN_THEMES].find((theme) => theme.label === name);
  return `${t("{name} (mine)", { name: preset ? t(name) : name })}${counter}`;
}

/** The default name of a copy. The theme's own name goes in as given; only the suffix is translated. */
export function copyName(name: string, t: Translate): string {
  return t("{name} copy", { name });
}
