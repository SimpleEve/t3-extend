import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { getPresetThemes } from "../themePalette"; // fork: theme presets
import { msg, T, useGT, useMessages } from "gt-react";
import { MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";

import { m } from "../i18n/messages";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { useTheme } from "../hooks/useTheme";
import { getThemeDefinition } from "../themePalette";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { useOpenThemeStudio } from "../fork/themeStudio/themeStudioStore"; // fork: theme studio
import { themeDisplayLabel } from "../fork/themeStudio/themeDisplayLabel"; // fork: theme studio
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { stackedThreadToast, toastManager } from "./ui/toast";

export const APPEARANCE_OPTIONS = [
  { mode: "system", label: msg("System"), icon: MonitorIcon },
  { mode: "light", label: msg("Light"), icon: SunIcon },
  { mode: "dark", label: msg("Dark"), icon: MoonIcon },
] as const;

export function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(msg("Couldn't save theme selection")),
      description: m(msg("Try again.")),
    }),
  );
}

// Reads its own source hooks so the compiler caches the cards on them. Taking the
// sources as arguments would leave it hook-free, and the compiler would cache nothing.
function useThemeCards() {
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const seen = new Set<string>();
  return [
    ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
    ...[...BUILT_IN_THEMES, ...getPresetThemes(), ...customThemes, ...environmentThemes] // fork: theme presets
      .filter((definition) => {
        if (seen.has(definition.id)) return false;
        seen.add(definition.id);
        return true;
      })
      .map((definition) => ({
        ...getThemeCardDefinition(definition),
        label: themeDisplayLabel(definition, t), // fork: preset and built-in names are translated
      })),
  ];
}

export function useCommandPaletteThemeItems() {
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const themeCards = useThemeCards();
  const openThemeStudio = useOpenThemeStudio(); // fork: theme studio
  const gt = useGT();
  const messages = useMessages();

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: gt("Change theme"),
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: gt("Change theme"),
        items: themeCards.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          description:
            previews.length === 1
              ? previews[0]!.mode === "light"
                ? gt("For light mode")
                : gt("For dark mode")
              : undefined,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                <span className="text-xs text-muted-foreground/70">
                  <T context="the theme or mode in use now">Current</T>
                </span>
              ) : null}
              <span className="flex items-center gap-1" aria-hidden>
                {previews.map((preview) => (
                  <ThemePreviewCircle
                    key={preview.mode}
                    colors={preview.colors}
                    mode={preview.mode}
                    className="size-3 border-0"
                  />
                ))}
              </span>
            </span>
          ),
          run: async () => {
            const saved =
              previews.length === 1 && id !== null
                ? setThemeHalf(previews[0]!.mode, id)
                : setTheme(id ?? appearanceMode);
            if (!saved) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    title: gt("Change appearance"),
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: gt("Change appearance"),
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: messages(label),
          searchTerms: [messages(label), label, "appearance", "mode"],
          icon: <Icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            appearanceMode === mode ? (
              <span className="text-xs text-muted-foreground/70">
                <T context="the theme or mode in use now">Current</T>
              </span>
            ) : undefined,
          run: async () => {
            if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };

  // fork: the studio is the one theme editor, so this entry opens it.
  const themeEditorItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize", "studio", "presets"], // fork: theme studio
    title: gt("Toggle theme editor"),
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      openThemeStudio(); // fork: theme studio
    },
  };

  return { changeThemeItem, changeAppearanceItem, themeEditorItem };
}
