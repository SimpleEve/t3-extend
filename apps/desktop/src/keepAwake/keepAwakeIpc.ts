import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { isMainRendererSender } from "../selfHost/selfHostIpc.ts";
import { makeKeepAwakeGuard } from "./KeepAwakeGuard.ts";
import { SET_KEEP_AWAKE_CHANNEL } from "./keepAwakeChannels.ts";

/**
 * Blocks only app suspension: the system will not idle-sleep, the screen may still turn off, and
 * closing the lid stays up to macOS.
 */
const guard = makeKeepAwakeGuard({
  start: () => Electron.powerSaveBlocker.start("prevent-app-suspension"),
  stop: (id) => {
    if (Electron.powerSaveBlocker.isStarted(id)) Electron.powerSaveBlocker.stop(id);
  },
});

const watched = new WeakSet<Electron.WebContents>();

/** A renderer that is destroyed, crashes, or loads another page no longer reports a running thread. */
function dropWhenRendererEnds(sender: Electron.WebContents): void {
  if (watched.has(sender)) return;
  watched.add(sender);
  const drop = () => guard.drop(sender.id);
  sender.once("destroyed", drop);
  sender.on("render-process-gone", drop);
  sender.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) drop();
  });
}

const setActive = DesktopIpc.makeIpcMethod({
  channel: SET_KEEP_AWAKE_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.keepAwake.setActive")(function* (active, event) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const webContents = Option.isSome(main) ? main.value.webContents : undefined;
    const trusted = isMainRendererSender({
      event,
      main: webContents === undefined || webContents.isDestroyed() ? undefined : webContents,
      applicationUrl: getDesktopUrl(environment.isDevelopment),
    });
    if (!trusted || event === undefined) {
      yield* Effect.logWarning("rejected keep-awake IPC from an untrusted sender");
      return;
    }
    const sender = Electron.webContents.fromId(event.sender.id);
    if (sender !== undefined) dropWhenRendererEnds(sender);
    guard.report(event.sender.id, active);
  }),
});

export const installKeepAwakeIpc = Effect.fn("desktop.ipc.keepAwake.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const app = yield* ElectronApp.ElectronApp;
  yield* ipc.handle(setActive);
  yield* app.on("before-quit", () => guard.releaseAll());
  yield* Effect.addFinalizer(() => Effect.sync(() => guard.releaseAll()));
});
