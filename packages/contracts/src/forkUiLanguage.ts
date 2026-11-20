// fork: before adopting upstream's `language` setting, T3 Extend stored the interface language as
// `uiLanguage` ("system" | "en" | "zh-Hans"). Saved settings are rewritten once, before decoding.
const LEGACY_TO_LANGUAGE: Readonly<Record<string, string>> = {
  system: "system",
  en: "en",
  "zh-Hans": "zh",
};

/** Moves a legacy `uiLanguage` into `language`; an explicit `language` wins. Other input passes through. */
export function migrateLegacyUiLanguage(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  if (!Object.hasOwn(raw, "uiLanguage")) return raw;
  const { uiLanguage, ...rest } = raw as Record<string, unknown>;
  if (typeof rest.language === "string") return rest;
  const language = typeof uiLanguage === "string" ? LEGACY_TO_LANGUAGE[uiLanguage] : undefined;
  return language === undefined ? rest : { ...rest, language };
}
