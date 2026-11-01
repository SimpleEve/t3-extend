import {
  getUiLocale,
  subscribeUiLocale,
  translatorFor,
  type Translator,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";
import { useSyncExternalStore } from "react";

// fork: mobile does not choose a language yet, so this stays English until a
// language setting calls `setUiLocale`.
export function useUiLocale(): UiLocale {
  return useSyncExternalStore(subscribeUiLocale, getUiLocale, getUiLocale);
}

/** Translates English source strings; changes identity only when the language does. */
export function useT(): Translator {
  return translatorFor(useUiLocale());
}
