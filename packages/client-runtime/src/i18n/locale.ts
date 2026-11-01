import type { UiLanguageSetting } from "@t3tools/contracts/settings";

export type UiLocale = "en" | "zh-Hans";

/**
 * Only Simplified Chinese has a catalog. Traditional Chinese tags fall back to
 * English rather than showing Simplified text to a Traditional reader.
 */
function resolveSystemUiLocale(systemLanguages: ReadonlyArray<string>): UiLocale {
  const primary = systemLanguages.find((tag) => tag.trim().length > 0);
  if (!primary) return "en";
  const parts = primary.trim().toLowerCase().replaceAll("_", "-").split("-");
  if (parts[0] !== "zh") return "en";
  const subtags = parts.slice(1);
  if (subtags.includes("hant")) return "en";
  if (subtags.includes("hans")) return "zh-Hans";
  const region = subtags.find((subtag) => subtag.length === 2);
  if (region === undefined || region === "cn" || region === "sg") return "zh-Hans";
  return "en";
}

export function resolveUiLanguage(
  setting: UiLanguageSetting,
  systemLanguages: ReadonlyArray<string>,
): UiLocale {
  return setting === "system" ? resolveSystemUiLocale(systemLanguages) : setting;
}

/** The tag for `Intl` formatters that should follow the interface language, such as month names. */
export function uiLocaleFormatTag(locale: UiLocale): string {
  return locale === "zh-Hans" ? "zh-CN" : "en-US";
}
