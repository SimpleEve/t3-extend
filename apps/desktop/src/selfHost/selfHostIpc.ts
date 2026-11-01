import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { isSameOriginRendererNavigation } from "../window/DesktopWindow.ts";
import * as DesktopSelfHost from "./DesktopSelfHost.ts";
import {
  GET_SELF_HOST_STATE_CHANNEL,
  RESTART_SELF_HOST_TUNNEL_CHANNEL,
  SELF_HOST_STATE_CHANNEL,
  SET_SELF_HOST_PUBLIC_URLS_CHANNEL,
  SET_SELF_HOST_TUNNEL_CHANNEL,
} from "./selfHostChannels.ts";

const SelfHostStateSchema = Schema.Struct({
  publicUrls: Schema.Array(Schema.String),
  environmentPublicUrls: Schema.Array(Schema.String),
  tunnel: Schema.Struct({
    command: Schema.String,
    enabled: Schema.Boolean,
    status: Schema.Literals(["stopped", "starting", "running", "backing-off"]),
    pid: Schema.NullOr(Schema.Number),
    restarts: Schema.Number,
    lastError: Schema.NullOr(Schema.String),
    lastExit: Schema.NullOr(
      Schema.Union([
        Schema.TaggedStruct("spawn-failed", {}),
        Schema.TaggedStruct("exited", { code: Schema.Number }),
        Schema.TaggedStruct("signaled", { signal: Schema.String }),
      ]),
    ),
    recentOutput: Schema.Array(Schema.String),
  }),
});

interface MainRenderer {
  readonly id: number;
  readonly mainFrame: { readonly url: string };
}

/**
 * The tunnel command runs on this machine, so only the main window's own top
 * frame, showing the app, may read or change it. Guest views, popups, and
 * subframes are refused.
 */
export function isMainRendererSender(input: {
  readonly event: DesktopIpc.DesktopIpcInvokeEvent | undefined;
  readonly main: MainRenderer | undefined;
  readonly applicationUrl: string;
}): boolean {
  const { event, main } = input;
  if (event === undefined || main === undefined || event.sender.id !== main.id) return false;
  const senderFrame = "senderFrame" in event ? event.senderFrame : undefined;
  return (
    senderFrame === main.mainFrame &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: main.mainFrame.url,
    })
  );
}

class SelfHostIpcUntrustedSenderError extends Schema.TaggedError<SelfHostIpcUntrustedSenderError>()(
  "SelfHostIpcUntrustedSenderError",
  {},
) {
  override get message(): string {
    return "Self-hosted connection settings are only available to the app window.";
  }
}

const ensureMainRendererSender = Effect.fn("desktop.ipc.selfHost.ensureMainRendererSender")(
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
      yield* Effect.logWarning("rejected self-hosted connection IPC from an untrusted sender", {
        senderId: event?.sender.id,
      });
      return yield* new SelfHostIpcUntrustedSenderError();
    }
  },
);

const getState = DesktopIpc.makeIpcMethod({
  channel: GET_SELF_HOST_STATE_CHANNEL,
  payload: Schema.Void,
  result: SelfHostStateSchema,
  handler: Effect.fn("desktop.ipc.selfHost.getState")(function* (_input, event) {
    yield* ensureMainRendererSender(event);
    return yield* (yield* DesktopSelfHost.DesktopSelfHost).getState;
  }),
});

const setPublicUrls = DesktopIpc.makeIpcMethod({
  channel: SET_SELF_HOST_PUBLIC_URLS_CHANNEL,
  payload: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  result: SelfHostStateSchema,
  handler: Effect.fn("desktop.ipc.selfHost.setPublicUrls")(function* (urls, event) {
    yield* ensureMainRendererSender(event);
    return yield* (yield* DesktopSelfHost.DesktopSelfHost).setPublicUrls(urls);
  }),
});

const setTunnel = DesktopIpc.makeIpcMethod({
  channel: SET_SELF_HOST_TUNNEL_CHANNEL,
  payload: Schema.Struct({ command: Schema.String, enabled: Schema.Boolean }),
  result: SelfHostStateSchema,
  handler: Effect.fn("desktop.ipc.selfHost.setTunnel")(function* (input, event) {
    yield* ensureMainRendererSender(event);
    return yield* (yield* DesktopSelfHost.DesktopSelfHost).setTunnel(input);
  }),
});

const restartTunnel = DesktopIpc.makeIpcMethod({
  channel: RESTART_SELF_HOST_TUNNEL_CHANNEL,
  payload: Schema.Void,
  result: SelfHostStateSchema,
  handler: Effect.fn("desktop.ipc.selfHost.restartTunnel")(function* (_input, event) {
    yield* ensureMainRendererSender(event);
    return yield* (yield* DesktopSelfHost.DesktopSelfHost).restartTunnel;
  }),
});

/** Registers the handlers and pushes tunnel status changes to every window. */
export const installSelfHostIpc = Effect.fn("desktop.ipc.selfHost.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(getState);
  yield* ipc.handle(setPublicUrls);
  yield* ipc.handle(setTunnel);
  yield* ipc.handle(restartTunnel);
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const selfHost = yield* DesktopSelfHost.DesktopSelfHost;
  yield* selfHost.changes.pipe(
    Stream.runForEach((state) => electronWindow.sendAll(SELF_HOST_STATE_CHANNEL, state)),
    Effect.forkScoped,
  );
});
