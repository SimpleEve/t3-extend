import {
  getUiLocale,
  resolveUiLanguage,
  setUiLocale,
  subscribeUiLocale,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";

import { toastManager } from "./components/ui/toast";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  subscribeClientSettings,
} from "./hooks/useSettings";

function systemLanguages(): ReadonlyArray<string> {
  return typeof navigator === "undefined" ? [] : navigator.languages;
}

// A stalled settings read (desktop IPC) or catalog chunk (slow remote network) must not hold first paint.
export const FIRST_PAINT_LANGUAGE_WAIT_MS = 1000;

export interface UiLanguageStartup {
  /** Resolves when first paint may go ahead. */
  readonly firstPaint: Promise<void>;
  /** Resolves once saved settings are read and the language they ask for has loaded or failed. */
  readonly settled: Promise<void>;
}

export interface UiLanguageOptions {
  /** True while a chunk-error reload is pending; a failure toast would only flash before it. */
  readonly isReloadScheduled: () => boolean;
}

// English on purpose: the catalog that would translate this is the one that failed.
function notifyCatalogLoadFailed() {
  toastManager.add({
    type: "warning",
    title: "Couldn't load the language pack",
    description: "The interface stays in its current language. Reload the page to try again.",
    timeout: 0,
    actionProps: {
      children: "Reload",
      onClick: () => window.location.reload(),
    },
  });
}

/**
 * Applies the saved interface language and keeps it and `<html lang>` in sync.
 * First paint waits until saved settings are read and any catalog they need has
 * loaded, so it is already translated, or `FIRST_PAINT_LANGUAGE_WAIT_MS`, whichever
 * is first; a late language switches the UI when it arrives.
 */
export function startUiLanguage(options: UiLanguageOptions): UiLanguageStartup {
  const root = document.documentElement;
  const syncLang = () => {
    root.lang = getUiLocale();
  };
  subscribeUiLocale(syncLang);
  syncLang();

  // Browsers cache a failed module load, so only a page reload can retry it. Tell the
  // user once per failed locale, not on every later settings change that reapplies it.
  let failedLocale: UiLocale | null = null;
  const applySavedUiLanguage = async () => {
    const locale = resolveUiLanguage(getClientSettings().uiLanguage, systemLanguages());
    await setUiLocale(locale);
    const wanted = resolveUiLanguage(getClientSettings().uiLanguage, systemLanguages());
    if (locale !== wanted) return;
    if (getUiLocale() === locale) {
      failedLocale = null;
      return;
    }
    if (failedLocale === locale || options.isReloadScheduled()) return;
    failedLocale = locale;
    notifyCatalogLoadFailed();
  };

  // Defaults must not decide the language before saved settings are read.
  const hydrated = ensureClientSettingsHydrated().catch(() => undefined);
  void hydrated.then(() => {
    subscribeClientSettings(() => void applySavedUiLanguage());
    window.addEventListener("languagechange", () => void applySavedUiLanguage());
  });
  const settled = hydrated.then(applySavedUiLanguage);
  const firstPaint = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, FIRST_PAINT_LANGUAGE_WAIT_MS);
    const done = () => {
      clearTimeout(timeout);
      resolve();
    };
    void settled.then(done, done);
  });
  return { firstPaint, settled };
}
