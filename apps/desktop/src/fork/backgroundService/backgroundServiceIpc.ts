import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { getDesktopUrl } from "../../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import { isMainRendererSender } from "../../selfHost/selfHostIpc.ts";
import * as DesktopBackgroundService from "./DesktopBackgroundService.ts";
import {
  GET_BACKGROUND_SERVICE_STATE_CHANNEL,
  SET_BACKGROUND_SERVICE_ENABLED_CHANNEL,
} from "./channels.ts";

const BackgroundServiceStateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["unavailable", "off", "on"]) }),
  Schema.Struct({
    kind: Schema.Literal("attention"),
    problem: Schema.Literals([
      "app-missing",
      "needs-repair",
      "other-home",
      "unreadable",
      "resume-failed",
    ]),
    reason: Schema.optional(Schema.String),
  }),
]);

class BackgroundServiceIpcUntrustedSenderError extends Schema.TaggedError<BackgroundServiceIpcUntrustedSenderError>()(
  "BackgroundServiceIpcUntrustedSenderError",
  {},
) {
  override get message(): string {
    return "The background service switch is only available to the app window.";
  }
}

/** The switch installs a login item that runs this app, so only its own top frame may use it. */
const ensureMainRendererSender = Effect.fn("desktop.ipc.backgroundService.ensureMainRenderer")(
  function* (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const webContents = Option.isSome(main) ? main.value.webContents : undefined;
    const trusted = isMainRendererSender({
      event,
      main: webContents === undefined || webContents.isDestroyed() ? undefined : webContents,
      applicationUrl: getDesktopUrl(environment.isDevelopment),
    });
    if (!trusted) {
      yield* Effect.logWarning("rejected background service IPC from an untrusted sender", {
        senderId: event?.sender.id,
      });
      return yield* new BackgroundServiceIpcUntrustedSenderError();
    }
  },
);

const getState = DesktopIpc.makeIpcMethod({
  channel: GET_BACKGROUND_SERVICE_STATE_CHANNEL,
  payload: Schema.Void,
  result: BackgroundServiceStateSchema,
  handler: Effect.fn("desktop.ipc.backgroundService.getState")(function* (_input, event) {
    yield* ensureMainRendererSender(event);
    return yield* (yield* DesktopBackgroundService.DesktopBackgroundService).getState;
  }),
});

const setEnabled = DesktopIpc.makeIpcMethod({
  channel: SET_BACKGROUND_SERVICE_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Struct({
    state: BackgroundServiceStateSchema,
    error: Schema.NullOr(Schema.String),
  }),
  handler: Effect.fn("desktop.ipc.backgroundService.setEnabled")(function* (enabled, event) {
    yield* ensureMainRendererSender(event);
    return yield* (yield* DesktopBackgroundService.DesktopBackgroundService).setEnabled(enabled);
  }),
});

export const installBackgroundServiceIpc = Effect.fn("desktop.ipc.backgroundService.install")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    yield* ipc.handle(getState);
    yield* ipc.handle(setEnabled);
  },
);
