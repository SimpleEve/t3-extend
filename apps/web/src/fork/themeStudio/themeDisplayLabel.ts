import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

import { getPresetThemes, type ThemeDefinition } from "../../themePalette";

// fork: kept apart from the studio hook so the command palette and the theme library can name a
// theme without loading the studio.

/** Our own presets and the built-in themes have translated names; a person's schemes do not. */
export function themeDisplayLabel(
  definition: ThemeDefinition,
  t: (text: string) => string,
): string {
  return getPresetThemes().some((preset) => preset.id === definition.id) ||
    BUILT_IN_THEMES.some((builtIn) => builtIn.id === definition.id)
    ? t(definition.label)
    : definition.label;
}
