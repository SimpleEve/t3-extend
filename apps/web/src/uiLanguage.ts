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

// A stalled settings read (desktop IPC) or catalog chunk (slow remote network) must not hold first paint.
export const FIRST_PAINT_LANGUAGE_WAIT_MS = 1000;

/**
 * Applies the saved interface language and keeps it and `<html lang>` in sync.
 * Resolves once saved settings are read and any catalog they need has loaded,
 * so first paint is already translated, or after `FIRST_PAINT_LANGUAGE_WAIT_MS`,
 * whichever is first; a late language switches the UI when it arrives.
 */
export function startUiLanguage(): Promise<void> {
  const root = document.documentElement;
  const syncLang = () => {
    root.lang = getUiLocale();
  };
  subscribeUiLocale(syncLang);
  syncLang();
  // Defaults must not decide the language before saved settings are read.
  const hydrated = ensureClientSettingsHydrated().catch(() => undefined);
  void hydrated.then(() => {
    subscribeClientSettings(() => void applySavedUiLanguage());
    window.addEventListener("languagechange", () => void applySavedUiLanguage());
  });
  const ready = hydrated.then(applySavedUiLanguage);
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, FIRST_PAINT_LANGUAGE_WAIT_MS);
    const done = () => {
      clearTimeout(timeout);
      resolve();
    };
    void ready.then(done, done);
  });
}
