// fork: Chinese text sizes. Chat and file Markdown read their sizes here, so the language is
// always an input and a switch re-renders the caller.
import { resolveNativeMarkdownTypography } from "../lib/appearancePreferences";
import { useUiLocale } from "../hooks/useT";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

export function useMarkdownTypography() {
  const { appearance } = useAppearancePreferences();
  return resolveNativeMarkdownTypography(appearance.baseFontSize, useUiLocale());
}
