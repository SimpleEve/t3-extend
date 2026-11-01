import type { UiLocale } from "./locale.ts";
import { loadUiCatalog, translate, type TranslateParams } from "./translate.ts";

export type Translator = (source: string, params?: TranslateParams, context?: string) => string;

let currentLocale: UiLocale = "en";
let requestedLocale: UiLocale = "en";
const listeners = new Set<() => void>();
const translators = new Map<UiLocale, Translator>();

/**
 * The active interface language, for code outside React such as toasts and
 * plain helpers. Read it when the text is shown, never at module top level:
 * modules load before saved settings decide the language.
 */
export function getUiLocale(): UiLocale {
  return currentLocale;
}

/** A `useSyncExternalStore`-shaped subscription to the active locale. */
export function subscribeUiLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One translator per locale, so its identity changes only when the language does. */
export function translatorFor(locale: UiLocale): Translator {
  let translator = translators.get(locale);
  if (!translator) {
    translator = (source, params, context) => translate(locale, source, params, context);
    translators.set(locale, translator);
  }
  return translator;
}

/**
 * Switches the interface language once its catalog has loaded, so nothing
 * renders half translated. A newer request wins over a slower older one, and
 * a failed load keeps the current language; asking again retries the load.
 */
export async function setUiLocale(locale: UiLocale): Promise<void> {
  requestedLocale = locale;
  const catalog = await loadUiCatalog(locale);
  if (locale !== "en" && catalog === null) return;
  if (requestedLocale !== locale || currentLocale === locale) return;
  currentLocale = locale;
  for (const listener of listeners) listener();
}
