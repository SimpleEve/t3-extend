import { resolveLocaleSelection } from "@t3tools/client-runtime/locales";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { getReactI18nCache, GTProvider, initializeGT, useLocale } from "gt-react-native";
import { createContext, use, useEffect, useMemo, type ReactNode } from "react";
import { Platform, TurboModuleRegistry, View, type TurboModule } from "react-native";

import { mobilePreferencesAtom } from "../state/preferences";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";
import { useLoadedLocaleSelection } from "./loadedLocaleSelection"; // fork
import { setActiveLocale } from "./messages";

const FormattingLocaleContext = createContext(DEFAULT_LOCALE);

export function useFormattingLocale(): string {
  return use(FormattingLocaleContext);
}

// Committed catalogs, so forks and offline installs never reach GT's CDN. English is the source.
// Required on demand: Metro runs every statically imported module at startup, and only one
// locale's catalog is ever used.
const CATALOGS: Readonly<Record<string, () => unknown>> = {
  es: () => require("./translations/es.json"),
  zh: () => require("./translations/zh.json"),
  "pt-BR": () => require("./translations/pt-BR.json"),
  fr: () => require("./translations/fr.json"),
  de: () => require("./translations/de.json"),
  ja: () => require("./translations/ja.json"),
  ko: () => require("./translations/ko.json"),
  ru: () => require("./translations/ru.json"),
  sv: () => require("./translations/sv.json"),
};

initializeGT({
  defaultLocale: DEFAULT_LOCALE,
  locales: [...SUPPORTED_LOCALES],
  loadTranslations: async (locale: string) => CATALOGS[locale]?.() ?? {},
  // Loaded catalogs never go stale; GT's default 60 s expiry would only reload the same file.
  cacheExpiryTime: null,
});

// fork: fills GT's catalog cache, which GTProvider reads the locale from.
const preloadCatalog = (locale: string) => getReactI18nCache().loadTranslations(locale);

// Read the device languages from gt-react-native's own native module: GT's getLocale() prefers
// the last locale passed to GTProvider, which it persists, so it can't express "system".
function readSystemLocales(): ReadonlyArray<string> {
  try {
    const locales =
      TurboModuleRegistry.get<{ getNativeLocales(): string[] } & TurboModule>(
        "GtReactNative",
      )?.getNativeLocales() ?? [];
    // On iOS the first entry is NSLocale.currentLocale, whose language is the app's bundle
    // localization (English only), not the user's; preferredLanguages follow it.
    return Platform.OS === "ios" ? locales.slice(1) : locales;
  } catch {
    return [];
  }
}

export function useLanguagePreference(): string {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.language ?? "system") // fork: unset follows the device, as T3 Extend always has
    : DEFAULT_LOCALE;
}

/** Translates the app into the saved language; "system" follows the device. Mounted once in App. */
export function I18nProvider(props: { readonly children: ReactNode }) {
  const { catalogLocale, formattingLocale } = resolveLocaleSelection(
    useLanguagePreference(),
    readSystemLocales(),
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  // GT suspends while a locale's catalog loads. Switching only once it has loaded keeps the current
  // language on screen until then, instead of GT's full-screen spinner.
  const selection = useLoadedLocaleSelection(
    useMemo(() => ({ catalogLocale, formattingLocale }), [catalogLocale, formattingLocale]),
    preloadCatalog, // fork: a deferred switch could stall, see loadedLocaleSelection
  );
  return (
    <GTProvider locale={selection.catalogLocale} fallback={<View className="flex-1 bg-screen" />}>
      <ActiveLocale />
      <FormattingLocaleContext value={selection.formattingLocale}>
        {props.children}
      </FormattingLocaleContext>
    </GTProvider>
  );
}

function ActiveLocale() {
  const locale = useLocale();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- call-time m() outside React reads the committed locale, whose catalog GT has loaded
  useEffect(() => setActiveLocale(locale), [locale]);
  return null;
}
