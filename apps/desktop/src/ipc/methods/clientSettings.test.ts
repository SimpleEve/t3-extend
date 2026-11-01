import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as DesktopApplicationMenu from "../../window/DesktopApplicationMenu.ts";
import { setClientSettings } from "./clientSettings.ts";

it.effect("rebuilds the native menu only when the interface language changes", () =>
  Effect.gen(function* () {
    const initialSettings: ClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      uiLanguage: "en",
    };
    const settings = yield* Ref.make(Option.some(initialSettings));
    let menuRebuilds = 0;
    const layer = Layer.mergeAll(
      Layer.succeed(
        DesktopClientSettings.DesktopClientSettings,
        DesktopClientSettings.DesktopClientSettings.of({
          get: Ref.get(settings),
          set: (next) => Ref.set(settings, Option.some(next)),
        }),
      ),
      Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
        configure: () => Effect.void,
      } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      Layer.succeed(DesktopApplicationMenu.DesktopApplicationMenu, {
        configure: Effect.sync(() => {
          menuRebuilds += 1;
        }),
      }),
    );

    yield* setClientSettings
      .handler({
        ...initialSettings,
        wordWrap: !initialSettings.wordWrap,
      })
      .pipe(Effect.provide(layer));
    assert.equal(menuRebuilds, 0);

    yield* setClientSettings
      .handler({
        ...initialSettings,
        uiLanguage: "zh-Hans",
        wordWrap: !initialSettings.wordWrap,
      })
      .pipe(Effect.provide(layer));
    assert.equal(menuRebuilds, 1);

    yield* setClientSettings
      .handler({
        ...initialSettings,
        uiLanguage: "zh-Hans",
      })
      .pipe(Effect.provide(layer));
    assert.equal(menuRebuilds, 1);
  }),
);
