import type { ThemeLook } from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useT } from "../../hooks/useT";
import {
  readThemeHalvesRaw,
  refreshTheme,
  useTheme,
  useThemeHalvesStored,
} from "../../hooks/useTheme";
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
  halvesWithout,
  hasUnsavedChanges,
  placeTheme,
  restoreSchemeToPreset,
  schemeBase,
  schemeColors,
  schemeCopyOf,
  STOCK_THEME_ID,
  studioOrigin,
  withSchemeColors,
  withSchemeCss,
  withSchemeLook,
} from "./studio.logic";
import { copyName, themeDisplayLabel } from "./themeDisplayLabel";
import { useThemeStudioDraft, useThemeStudioIntent } from "./themeStudioStore";

/** The stock T3 theme has no definition of its own, so editing it starts from its two palettes. */
function stockDefinition(): ThemeDefinition {
  return {
    id: STOCK_THEME_ID,
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
  // A saved scheme is read from the list this hook subscribes to, so an edit that was just applied
  // shows at once. getThemeDefinition reads the same list, but the compiler cannot see that and
  // would keep the old definition for as long as the id stays the same.
  const applied =
    customThemes.find((saved) => saved.id === appliedId) ?? getThemeDefinition(appliedId);
  const base = applied ?? stockDefinition();

  const storedHalves = useThemeHalvesStored();
  // Light and dark set apart: the studio changes the half in use and leaves the other alone.
  const place = (themeId: string) => {
    const placement = placeTheme(readThemeHalvesRaw(), resolvedTheme, themeId);
    return placement.kind === "half"
      ? setThemeHalf(placement.appearance, placement.themeId)
      : setTheme(placement.themeId);
  };
  const halvesInUse = placeTheme(storedHalves, resolvedTheme, "").kind === "half";

  const labelOf = (definition: ThemeDefinition) => themeDisplayLabel(definition, t);
  const mineLabel = (definition: ThemeDefinition) =>
    t("{name} (mine)", { name: labelOf(definition) });

  // Kept in a store, so leaving the page and coming back finds the same unsaved draft.
  const draft = useThemeStudioDraft((state) => state.draft);
  const setDraft = useThemeStudioDraft((state) => state.setDraft);
  const explicitCopy = useThemeStudioDraft((state) => state.explicitCopy);
  const setExplicitCopy = useThemeStudioDraft((state) => state.setExplicitCopy);
  const [hovered, setHovered] = useState<ThemeDefinition | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  // A switch to another theme that waits for an answer, because it would drop an unsaved draft.
  const [pendingSwitch, setPendingSwitch] = useState<{ themeId: string | null } | null>(null);
  const colorEditSnapshot = useRef<ThemeDefinition | null | undefined>(undefined);
  const working = draft ?? base;
  const savedScheme = draft ? (customThemes.find((saved) => saved.id === draft.id) ?? null) : null;
  const dirty =
    hasUnsavedChanges(draft, savedScheme, base) || (explicitCopy && draft !== null && !savedScheme);
  const editAppearance = editableAppearance(working, resolvedTheme);
  const preset = schemeBase(working.basedOn, getThemeDefinition, customThemes);
  // A stored image chosen in the studio, or one published beside the theme.
  const background =
    working.look?.background !== undefined ||
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

  // A "Duplicate" or "Create" request starts as a copy, replacing any draft left from before; an
  // "Edit" switches to its theme. Layout timing, so the copy is there on the first painted frame.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes the one-shot request a theme library button or the command palette left in the studio store
  useLayoutEffect(() => {
    const intent = useThemeStudioIntent.getState().take();
    if (intent === null) return;
    if (intent.duplicate) {
      const { origin, restorable } = studioOrigin({
        themeId: intent.themeId,
        find: getThemeDefinition,
        applied,
        stock: stockDefinition(),
      });
      setDraft(
        beginScheme({
          base: origin,
          savedThemes: customThemes,
          mineLabel: intent.name ?? mineLabel(origin),
          restorable,
          forceFork: true,
        }),
      );
      setExplicitCopy(true);
      return;
    }
    if (intent.themeId === null) return;
    const target = getThemeDefinition(intent.themeId);
    // A draft of another theme is not what an Edit of this one asked to see.
    const { draft: kept } = useThemeStudioDraft.getState();
    if (kept !== null && kept.id !== intent.themeId && kept.basedOn !== intent.themeId) {
      setDraft(null);
      setExplicitCopy(false);
    }
    if (target !== null && target.id !== appliedId) place(target.id);
  });

  const select = (themeId: string | null) => {
    setDraft(null);
    setExplicitCopy(false);
    setHovered(null);
    setSaveFailed(false);
    return setTheme(themeId ?? (appearanceMode === "system" ? "system" : appearanceMode));
  };

  // Saves a copy of what is on screen under a name. A saved scheme the copy came from stays as it
  // was, so versions of one preset never write over each other.
  const saveAs = (name: string) => {
    const copy = schemeCopyOf({
      scheme:
        draft ??
        beginScheme({
          base,
          savedThemes: customThemes,
          mineLabel: mineLabel(base),
          restorable: applied !== null,
        }),
      name,
      savedThemes: customThemes,
    });
    try {
      installCustomTheme(copy);
    } catch {
      setSaveFailed(true);
      return false;
    }
    if (!place(copy.id)) {
      setSaveFailed(true);
      return false;
    }
    setSaveFailed(false);
    setDraft(null);
    setExplicitCopy(false);
    setHovered(null);
    return true;
  };

  // The name a new version starts with: the fork's own name, or a copy of the scheme in use.
  const suggestedName =
    draft !== null && savedScheme === null
      ? draft.label
      : applied !== null && customThemes.some((saved) => saved.id === applied.id)
        ? copyName(labelOf(applied), t)
        : mineLabel(base);

  const duplicate = (scheme: ThemeDefinition) => {
    try {
      installCustomTheme(
        schemeCopyOf({
          scheme,
          name: copyName(labelOf(scheme), t),
          savedThemes: customThemes,
        }),
      );
    } catch {
      setSaveFailed(true);
    }
  };

  // A person's click on a theme. With unsaved changes it asks first instead of dropping them.
  const choose = (themeId: string | null) => {
    if (dirty) {
      setPendingSwitch({ themeId });
      return;
    }
    select(themeId);
  };
  const resolveSwitch = (action: "save" | "discard" | "keep") => {
    const target = pendingSwitch;
    setPendingSwitch(null);
    if (target === null || action === "keep") return;
    if (action === "save" && !(savedScheme ? apply() : saveAs(suggestedName))) return;
    select(target.themeId);
  };

  const apply = () => {
    if (draft === null) return false;
    try {
      if (savedScheme) updateCustomTheme(draft);
      else installCustomTheme(draft);
    } catch {
      setSaveFailed(true);
      return false;
    }
    if (applied?.id !== draft.id && !place(draft.id)) {
      setSaveFailed(true);
      return false;
    }
    setSaveFailed(false);
    // The effect repaints from the stored scheme once there is no draft.
    setDraft(null);
    setExplicitCopy(false);
    return true;
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
    // Read before setTheme clears the mix; a half whose theme has not loaded yet still counts.
    const halves = readThemeHalvesRaw();
    const modeOnly = appearanceMode === "system" ? "system" : appearanceMode;
    if (getThemeDefinition(theme)?.id === scheme.id) {
      if (!setTheme(modeOnly)) return;
      const kept = halvesWithout(halves, scheme.id);
      for (const appearance of ["light", "dark"] as const) {
        const half = kept[appearance];
        if (half !== undefined) setThemeHalf(appearance, half);
      }
    } else {
      for (const appearance of ["light", "dark"] as const) {
        if (halves[appearance] === scheme.id) setThemeHalf(appearance, null);
      }
    }
    setHovered(null);
    try {
      removeCustomTheme(scheme.id);
    } catch {
      setSaveFailed(true);
      return;
    }
    setDraft((current) => (current?.id === scheme.id ? null : current));
  };

  const presetLabel = (themeId: string) => {
    const definition = schemeBase(themeId, getThemeDefinition, customThemes);
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
    halvesInUse,
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
    choose,
    pendingSwitch,
    resolveSwitch,
    saveAs,
    suggestedName,
    duplicate,
    apply,
    revert,
    restoreToPreset,
    rename,
    remove,
    labelOf,
    presetLabel,
  };
}
