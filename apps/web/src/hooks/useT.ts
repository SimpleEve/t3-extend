import {
  getUiLocale,
  subscribeUiLocale,
  translatorFor,
  type Translator,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";
import { useSyncExternalStore } from "react";

export function useUiLocale(): UiLocale {
  return useSyncExternalStore(subscribeUiLocale, getUiLocale, getUiLocale);
}

/** Translates English source strings; changes identity only when the language does. */
export function useT(): Translator {
  return translatorFor(useUiLocale());
}

/** For JSX built outside a component, such as module-level constants, where `useT` can't run. */
export function Translated({ source }: { readonly source: string }): string {
  return useT()(source);
}
