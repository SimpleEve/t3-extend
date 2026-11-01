import type { UiLanguageSetting } from "@t3tools/contracts/settings";
import {
  getUiLocale,
  resolveUiLanguage,
  setUiLocale,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";

// Same cap as web: a stalled catalog load must not hold the splash screen.
export const FIRST_FRAME_LANGUAGE_WAIT_MS = 1000;

interface UiLanguageControllerDeps {
  readonly setLocale: (locale: UiLocale) => Promise<void>;
  readonly currentLocale: () => UiLocale;
}

const defaultDeps: UiLanguageControllerDeps = {
  setLocale: setUiLocale,
  currentLocale: getUiLocale,
};

/**
 * Android reports Java `Locale.toString()` (`zh_CN_#Hans`, `zh__#Hant`), which
 * `resolveUiLanguage` would misread; turn it into a BCP 47 tag first.
 */
export function androidLocaleTag(identifier: string): string {
  return identifier
    .replaceAll("#", "")
    .split("_")
    .filter((part) => part.length > 0)
    .join("-");
}

/**
 * Applies the saved interface language. `ready` turns true once the first
 * language is applied, or after `FIRST_FRAME_LANGUAGE_WAIT_MS`, whichever is first;
 * English is ready at once because it loads no catalog.
 */
export function createUiLanguageController(deps: UiLanguageControllerDeps = defaultDeps) {
  let ready = false;
  let lastSetting: UiLanguageSetting | null = null;
  let wantedLocale: UiLocale | null = null;
  const listeners = new Set<() => void>();

  const markReady = () => {
    if (ready) return;
    ready = true;
    for (const listener of listeners) listener();
  };

  const applyLocale = async (locale: UiLocale) => {
    wantedLocale = locale;
    await deps.setLocale(locale);
    if (wantedLocale === locale && deps.currentLocale() !== locale) {
      console.warn("[i18n] could not load the language pack; staying in the current language", {
        locale,
      });
    }
  };

  return {
    apply(setting: UiLanguageSetting, systemLanguages: ReadonlyArray<string>): void {
      if (setting === lastSetting) return;
      lastSetting = setting;
      const locale = resolveUiLanguage(setting, systemLanguages);
      const applied = applyLocale(locale);
      if (ready) return;
      if (locale === "en") {
        markReady();
        return;
      }
      const timeout = setTimeout(markReady, FIRST_FRAME_LANGUAGE_WAIT_MS);
      void applied.finally(() => {
        clearTimeout(timeout);
        markReady();
      });
    },
    isReady: () => ready,
    subscribeReady(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
