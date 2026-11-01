import { useSyncExternalStore } from "react";
import { I18nManager, Platform, Settings } from "react-native";
import { AsyncResult } from "effect/reactivity";

import { uiLanguageSettingOf } from "../persistence/mobile-preferences";
import { appAtomRegistry } from "../state/atom-registry";
import { mobilePreferencesAtom } from "../state/preferences";
import { androidLocaleTag, createUiLanguageController } from "./uiLanguageController";

/**
 * Android's I18nManager reports the app's resource locale (system list or per-app
 * language). iOS `AppleLanguages` is the user's own list, independent of which
 * localizations the bundle declares. Both are constants read once per launch.
 */
function deviceLanguages(): ReadonlyArray<string> {
  if (Platform.OS === "android") {
    const identifier = I18nManager.getConstants().localeIdentifier;
    if (identifier) return [androidLocaleTag(identifier)];
  }
  if (Platform.OS === "ios") {
    const languages: unknown = Settings.get("AppleLanguages");
    if (Array.isArray(languages)) {
      const tags = languages.filter((tag): tag is string => typeof tag === "string");
      if (tags.length > 0) return tags;
    }
  }
  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale];
  } catch {
    return [];
  }
}

const controller = createUiLanguageController();

/** App-lifetime: applies the saved language now and whenever the preference changes. */
export function installUiLanguageRuntime(): () => void {
  let systemLanguages: ReadonlyArray<string> | null = null;
  return appAtomRegistry.subscribe(
    mobilePreferencesAtom,
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      systemLanguages ??= deviceLanguages();
      controller.apply(uiLanguageSettingOf(result.value), systemLanguages);
    },
    { immediate: true },
  );
}

/** False until the saved language is applied or its wait runs out; holds the splash screen. */
export function useUiLanguageReady(): boolean {
  return useSyncExternalStore(controller.subscribeReady, controller.isReady, controller.isReady);
}
