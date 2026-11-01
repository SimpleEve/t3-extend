import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
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
    recentOutput: Schema.Array(Schema.String),
  }),
});

const getState = DesktopIpc.makeIpcMethod({
  channel: GET_SELF_HOST_STATE_CHANNEL,
  payload: Schema.Void,
  result: SelfHostStateSchema,
  handler: Effect.fn("desktop.ipc.selfHost.getState")(function* () {
    return yield* (yield* DesktopSelfHost.DesktopSelfHost).getState;
  }),
});

const setPublicUrls = DesktopIpc.makeIpcMethod({
  channel: SET_SELF_HOST_PUBLIC_URLS_CHANNEL,
  payload: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  result: SelfHostStateSchema,
  handler: Effect.fn("desktop.ipc.selfHost.setPublicUrls")(function* (urls) {
    return yield* (yield* DesktopSelfHost.DesktopSelfHost).setPublicUrls(urls);
  }),
});

const setTunnel = DesktopIpc.makeIpcMethod({
  channel: SET_SELF_HOST_TUNNEL_CHANNEL,
  payload: Schema.Struct({ command: Schema.String, enabled: Schema.Boolean }),
  result: SelfHostStateSchema,
  handler: Effect.fn("desktop.ipc.selfHost.setTunnel")(function* (input) {
    return yield* (yield* DesktopSelfHost.DesktopSelfHost).setTunnel(input);
  }),
});

const restartTunnel = DesktopIpc.makeIpcMethod({
  channel: RESTART_SELF_HOST_TUNNEL_CHANNEL,
  payload: Schema.Void,
  result: SelfHostStateSchema,
  handler: Effect.fn("desktop.ipc.selfHost.restartTunnel")(function* () {
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
