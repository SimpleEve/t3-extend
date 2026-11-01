import {
  getUiLocale,
  resolveUiLanguage,
  setUiLocale,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

/**
 * fork: the interface language of native menus and dialogs. It follows the
 * renderer's saved `uiLanguage`; "system" reads the OS language list.
 */
export class DesktopUiLanguage extends Context.Service<
  DesktopUiLanguage,
  {
    /** Resolves the saved language, loads its catalog, and returns the language now current. */
    readonly apply: Effect.Effect<UiLocale>;
  }
>()("@t3tools/desktop/settings/DesktopUiLanguage") {}

const make = Effect.gen(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;

  const apply = Effect.gen(function* () {
    const saved = yield* clientSettings.get.pipe(Effect.orElseSucceed(() => Option.none()));
    const setting = Option.match(saved, {
      onNone: () => DEFAULT_CLIENT_SETTINGS.uiLanguage,
      onSome: (settings) => settings.uiLanguage,
    });
    const locale = resolveUiLanguage(setting, yield* electronApp.preferredSystemLanguages);
    yield* Effect.promise(() => setUiLocale(locale));
    // A catalog that failed to load leaves the previous language current.
    return getUiLocale();
  }).pipe(Effect.withSpan("desktop.uiLanguage.apply"));

  return DesktopUiLanguage.of({ apply });
});

export const layer = Layer.effect(DesktopUiLanguage, make);
