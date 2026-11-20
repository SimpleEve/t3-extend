import type { ThemeLook } from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";

import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useT } from "../../hooks/useT";
import { refreshTheme, useTheme } from "../../hooks/useTheme";
import { themeServerEnvironmentThemesAtom } from "../../state/server";
import {
  applyThemeColorPreview,
  getPresetThemes,
  getStandardThemeColors,
  getThemeDefinition,
  installCustomTheme,
  removeCustomTheme,
  resolveThemeHalf,
  THEME_PREVIEW_ID,
  updateCustomTheme,
  type ThemeColors,
  type ThemeDefinition,
} from "../../themePalette";
import {
  beginScheme,
  editableAppearance,
  hasUnsavedChanges,
  restoreSchemeToPreset,
  schemeColors,
  withSchemeColors,
  withSchemeCss,
  withSchemeLook,
} from "./studio.logic";
import { useThemeStudioIntent } from "./themeStudioStore";

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

/** The stock T3 theme has no definition of its own, so editing it starts from its two palettes. */
function stockDefinition(): ThemeDefinition {
  return {
    id: "t3-code",
    label: FORK.appBaseName,
    appearance: "light",
    colors: getStandardThemeColors("light"),
    variants: { dark: getStandardThemeColors("dark") },
  };
}

export function useThemeStudio() {
  const t = useT();
  const { theme, themeHalves, resolvedTheme, appearanceMode, setTheme, setThemeHalf } = useTheme();
  const customThemes = useCustomThemes();
  const environmentThemes = useAtomValue(themeServerEnvironmentThemesAtom);
  const appliedId = resolveThemeHalf(theme, themeHalves, resolvedTheme);
  const applied = getThemeDefinition(appliedId);
  const base = applied ?? stockDefinition();

  const labelOf = (definition: ThemeDefinition) => themeDisplayLabel(definition, t);
  const mineLabel = (definition: ThemeDefinition) =>
    t("{name} (mine)", { name: labelOf(definition) });

  // A "Duplicate" or "Create" request starts as a copy; reading it here is pure, and the effect
  // below clears it, so a double render cannot lose it.
  const [draft, setDraft] = useState<ThemeDefinition | null>(() => {
    const intent = useThemeStudioIntent.getState().intent;
    if (intent === null || !intent.duplicate) return null;
    const target = intent.themeId === null ? null : getThemeDefinition(intent.themeId);
    const origin = target ?? base;
    return beginScheme({
      base: origin,
      savedThemes: customThemes,
      mineLabel: intent.name ?? mineLabel(origin),
      restorable: target !== null || applied !== null,
      forceFork: true,
    });
  });
  // A copy someone asked for is worth saving even before it differs from its original.
  const [explicitCopy, setExplicitCopy] = useState(
    () => useThemeStudioIntent.getState().intent?.duplicate === true,
  );
  const [hovered, setHovered] = useState<ThemeDefinition | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const colorEditSnapshot = useRef<ThemeDefinition | null | undefined>(undefined);
  const working = draft ?? base;
  const savedScheme = draft ? (customThemes.find((saved) => saved.id === draft.id) ?? null) : null;
  const dirty =
    hasUnsavedChanges(draft, savedScheme, base) || (explicitCopy && draft !== null && !savedScheme);
  const editAppearance = editableAppearance(working, resolvedTheme);
  const preset = working.basedOn ? getThemeDefinition(working.basedOn) : null;
  const background =
    environmentThemes?.find((published) => published.id === working.id)?.background !== undefined;

  const edit = (update: (scheme: ThemeDefinition) => ThemeDefinition) => {
    setDraft((current) =>
      update(
        current ??
          beginScheme({
            base,
            savedThemes: customThemes,
            mineLabel: mineLabel(base),
            restorable: applied !== null,
          }),
      ),
    );
  };

  const setColors = (update: (colors: ThemeColors) => ThemeColors) =>
    edit((scheme) => {
      const colors = schemeColors(scheme, editAppearance) ?? scheme.colors;
      return withSchemeColors(scheme, editAppearance, update(colors));
    });
  const setLook = <K extends keyof ThemeLook>(key: K, value: ThemeLook[K] | undefined) =>
    edit((scheme) => withSchemeLook(scheme, key, value));
  const setCss = (css: string) => edit((scheme) => withSchemeCss(scheme, css));

  // A color edit also rewrites derived roles, so cancelling restores the whole draft.
  const startColorEdit = () => {
    colorEditSnapshot.current = draft;
  };
  const cancelColorEdit = () => {
    if (colorEditSnapshot.current !== undefined) setDraft(colorEditSnapshot.current);
    colorEditSnapshot.current = undefined;
  };

  const previewing = hovered ?? draft;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the draft or hovered preset on the document as a live preview, and restores the stored theme when there is none
  useEffect(() => {
    if (previewing === null) {
      if (document.documentElement.dataset.themeId === THEME_PREVIEW_ID) refreshTheme();
      return;
    }
    const appearance = schemeColors(previewing, resolvedTheme)
      ? resolvedTheme
      : previewing.appearance;
    applyThemeColorPreview(
      schemeColors(previewing, appearance) ?? previewing.colors,
      appearance,
      previewing.css,
      previewing.look,
    );
  }, [previewing, resolvedTheme]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaving the page must not leave a preview painted
  useEffect(
    () => () => {
      if (document.documentElement.dataset.themeId === THEME_PREVIEW_ID) refreshTheme();
    },
    [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the one-shot request a theme library button or the command palette left in the studio store, and switches to the theme an Edit asked for
  useEffect(() => {
    const intent = useThemeStudioIntent.getState().take();
    if (intent === null || intent.duplicate || intent.themeId === null) return;
    const target = getThemeDefinition(intent.themeId);
    if (target !== null && target.id !== appliedId) setTheme(target.id);
  }, [appliedId, setTheme]);

  const select = (themeId: string | null) => {
    setDraft(null);
    setExplicitCopy(false);
    setHovered(null);
    setSaveFailed(false);
    return setTheme(themeId ?? (appearanceMode === "system" ? "system" : appearanceMode));
  };

  const apply = () => {
    if (draft === null) return;
    try {
      if (savedScheme) updateCustomTheme(draft);
      else installCustomTheme(draft);
    } catch {
      setSaveFailed(true);
      return;
    }
    if (applied?.id !== draft.id && !setTheme(draft.id)) {
      setSaveFailed(true);
      return;
    }
    setSaveFailed(false);
    // The effect repaints from the stored scheme once there is no draft.
    setDraft(null);
    setExplicitCopy(false);
  };

  const revert = () => {
    setDraft(null);
    setExplicitCopy(false);
    setSaveFailed(false);
  };

  const rename = (scheme: ThemeDefinition, label: string) => {
    const name = label.trim();
    if (name === "" || name === scheme.label) return;
    try {
      updateCustomTheme({ ...scheme, label: name });
    } catch {
      setSaveFailed(true);
      return;
    }
    setDraft((current) => (current?.id === scheme.id ? { ...current, label: name } : current));
  };

  const remove = (scheme: ThemeDefinition) => {
    if (applied?.id === scheme.id && !select(null)) return;
    for (const appearance of ["light", "dark"] as const) {
      if (themeHalves?.[appearance] === scheme.id) setThemeHalf(appearance, null);
    }
    try {
      removeCustomTheme(scheme.id);
    } catch {
      setSaveFailed(true);
      return;
    }
    setDraft((current) => (current?.id === scheme.id ? null : current));
  };

  const presetLabel = (themeId: string) => {
    const definition = getThemeDefinition(themeId);
    return definition ? labelOf(definition) : null;
  };

  const restoreToPreset = () => {
    if (preset === null) return;
    edit((scheme) => restoreSchemeToPreset(scheme, preset));
  };

  return {
    t,
    working,
    applied,
    draft,
    dirty,
    saveFailed,
    isFork: draft !== null && savedScheme === null,
    editAppearance,
    preset,
    background,
    customThemes,
    presets: getPresetThemes(),
    resolvedTheme,
    themeHalves,
    theme,
    appearanceMode,
    setTheme,
    setThemeHalf,
    setHovered,
    setColors,
    setLook,
    setCss,
    startColorEdit,
    cancelColorEdit,
    select,
    apply,
    revert,
    restoreToPreset,
    rename,
    remove,
    labelOf,
    presetLabel,
  };
}
