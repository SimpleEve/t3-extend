import { useT } from "../../hooks/useT";
import { useTheme } from "../../hooks/useTheme";
import { Button } from "../../components/ui/button";
import { SettingsRow } from "../../components/settings/settingsLayout";
import { getThemeDefinition, resolveThemeHalf } from "../../themePalette";
import { themeDisplayLabel } from "./useThemeStudio";
import { overriddenSettings } from "./studio.logic";
import { useActiveThemeLook } from "./themeLook";
import { useOpenThemeStudio } from "./themeStudioStore";

/** Tells which of the settings below the current theme's look is overriding, so a slider that does nothing is not a mystery. */
export function ThemeLookNotice() {
  const t = useT();
  const look = useActiveThemeLook();
  const { theme, themeHalves, resolvedTheme } = useTheme();
  const openThemeStudio = useOpenThemeStudio();
  const overridden = overriddenSettings(look);
  if (overridden.length === 0) return null;
  const active = getThemeDefinition(resolveThemeHalf(theme, themeHalves, resolvedTheme));
  const name = active ? themeDisplayLabel(active, t) : "";
  const fonts = overridden.includes("fontUi") || overridden.includes("fontCode");
  const width = overridden.includes("chatWidth");
  const description = fonts
    ? width
      ? t(
          "“{theme}” sets the fonts and the chat width, so your own choices below only apply where it leaves them alone.",
          { theme: name },
        )
      : t(
          "“{theme}” sets the fonts, so your own font choices below only apply where it leaves a font alone.",
          { theme: name },
        )
    : t(
        "“{theme}” sets the chat width, so the chat width below does not apply while it is in use.",
        { theme: name },
      );
  return (
    <SettingsRow
      id="theme-look-overrides"
      title="Set by the theme"
      description={description}
      control={
        <Button size="xs" variant="outline" onClick={() => openThemeStudio()}>
          {t("Open theme studio")}
        </Button>
      }
    />
  );
}
