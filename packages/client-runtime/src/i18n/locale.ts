export type UiLocale = "en" | "zh-Hans";

/**
 * The fork's catalog for GT's active locale. GT decides the language from the `language` setting;
 * the fork only has Simplified Chinese, and GT's `zh` is Simplified, so every other locale reads
 * the fork's own text in English.
 */
export function uiLocaleForLanguage(gtLocale: string): UiLocale {
  return gtLocale.toLowerCase().split(/[-_]/)[0] === "zh" ? "zh-Hans" : "en";
}
