import {
  getUiLocale,
  resolveUiLanguage,
  setUiLocale,
  subscribeUiLocale,
} from "@t3tools/client-runtime/i18n";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  subscribeClientSettings,
} from "./hooks/useSettings";

function systemLanguages(): ReadonlyArray<string> {
  return typeof navigator === "undefined" ? [] : navigator.languages;
}

function applySavedUiLanguage(): Promise<void> {
  return setUiLocale(resolveUiLanguage(getClientSettings().uiLanguage, systemLanguages()));
}

/**
 * Applies the saved interface language and keeps it and `<html lang>` in sync.
 * Resolves once saved settings are read and any catalog they need has loaded,
 * so first paint is already translated. English loads nothing extra.
 */
export function startUiLanguage(): Promise<void> {
  const root = document.documentElement;
  const syncLang = () => {
    root.lang = getUiLocale();
  };
  subscribeUiLocale(syncLang);
  syncLang();
  // Defaults must not decide the language before saved settings are read.
  const ready = ensureClientSettingsHydrated()
    .catch(() => undefined)
    .then(applySavedUiLanguage);
  void ready.then(() => {
    subscribeClientSettings(() => void applySavedUiLanguage());
    window.addEventListener("languagechange", () => void applySavedUiLanguage());
  });
  return ready;
}
