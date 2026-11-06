// fork: the gateway's IPC surface and its place in the app's startup
// (research/remote-loopback-forwarding.md 2.3, 4.7). Only the main window's own top frame may
// drive it; webviews and subframes are refused, as for the other fork bridges.
import {
  LoopbackGatewayEnvironmentInput,
  LoopbackGatewayRegisterInput,
  LoopbackGatewaySetEnabledInput,
  LoopbackGatewaySetReachableInput,
  LoopbackGatewayStatus,
  LoopbackGatewayUpdateTicketInput,
  type LoopbackGatewayEvent,
} from "@t3tools/shared/forkLoopbackGateway/bridge";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import { getDesktopUrl } from "../../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import { isMainRendererSender } from "../../selfHost/selfHostIpc.ts";
import {
  LOOPBACK_GATEWAY_EVENT_CHANNEL,
  LOOPBACK_GATEWAY_GET_STATUS_CHANNEL,
  LOOPBACK_GATEWAY_REGISTER_CHANNEL,
  LOOPBACK_GATEWAY_SET_ENABLED_CHANNEL,
  LOOPBACK_GATEWAY_SET_REACHABLE_CHANNEL,
  LOOPBACK_GATEWAY_UNREGISTER_CHANNEL,
  LOOPBACK_GATEWAY_UPDATE_TICKET_CHANNEL,
} from "./channels.ts";
import { renderGatewayErrorPage } from "./errorPage.ts";
import { GatewayInvalidTicketError } from "./GatewayEnvironment.ts";
import {
  makeLoopbackGatewayHost,
  makeProxyLoginListener,
  type LoopbackGatewayHost,
} from "./LoopbackGatewayHost.ts";

class LoopbackGatewayIpcError extends Schema.TaggedError<LoopbackGatewayIpcError>()(
  "LoopbackGatewayIpcError",
  { reason: Schema.Literals(["untrusted-sender", "invalid-ticket", "failed"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "untrusted-sender":
        return "The loopback gateway is only available to the app window.";
      case "invalid-ticket":
        return "The loopback gateway ticket has an unexpected shape.";
      case "failed":
        return "The loopback gateway could not apply the change.";
    }
  }
}

/** The host the running app uses; `undefined` before startup and after shutdown. */
let installedHost: LoopbackGatewayHost | undefined;

/**
 * Called when a browser session is handed out for an environment (`getPreviewConfig`). Fails
 * closed: if a proxy is due and cannot be set, the webview must not be created, or its page
 * would reach this computer's own `localhost`.
 */
export const installLoopbackGatewaySession = Effect.fn("desktop.loopbackGateway.installSession")(
  function* (environmentId: string, session: Electron.Session) {
    const host = installedHost;
    if (host === undefined) return;
    yield* Effect.tryPromise({
      try: () => host.installSession(environmentId, session),
      catch: () => new LoopbackGatewayIpcError({ reason: "failed" }),
    }).pipe(Effect.orDie);
  },
);

const ensureMainRenderer = Effect.fn("desktop.loopbackGateway.ensureMainRenderer")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const webContents = Option.isSome(main) ? main.value.webContents : undefined;
  const trusted = isMainRendererSender({
    event,
    main: webContents === undefined || webContents.isDestroyed() ? undefined : webContents,
    applicationUrl: getDesktopUrl(environment.isDevelopment),
  });
  if (!trusted) return yield* new LoopbackGatewayIpcError({ reason: "untrusted-sender" });
});

/** A fixed error for the renderer: the cause of a failure is never allowed near a ticket. */
const run = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) =>
      new LoopbackGatewayIpcError({
        reason: error instanceof GatewayInvalidTicketError ? "invalid-ticket" : "failed",
      }),
  });

const methodsFor = (host: LoopbackGatewayHost) => [
  DesktopIpc.makeIpcMethod({
    channel: LOOPBACK_GATEWAY_REGISTER_CHANNEL,
    payload: LoopbackGatewayRegisterInput,
    result: LoopbackGatewayStatus,
    handler: Effect.fn("desktop.ipc.loopbackGateway.register")(function* (input, event) {
      yield* ensureMainRenderer(event);
      return yield* run(() => host.register(input));
    }),
  }),
  DesktopIpc.makeIpcMethod({
    channel: LOOPBACK_GATEWAY_UPDATE_TICKET_CHANNEL,
    payload: LoopbackGatewayUpdateTicketInput,
    result: Schema.NullOr(LoopbackGatewayStatus),
    handler: Effect.fn("desktop.ipc.loopbackGateway.updateTicket")(function* (input, event) {
      yield* ensureMainRenderer(event);
      return yield* run(() => host.updateTicket(input.environmentId, input.credential));
    }),
  }),
  DesktopIpc.makeIpcMethod({
    channel: LOOPBACK_GATEWAY_UNREGISTER_CHANNEL,
    payload: LoopbackGatewayEnvironmentInput,
    result: Schema.Void,
    handler: Effect.fn("desktop.ipc.loopbackGateway.unregister")(function* (input, event) {
      yield* ensureMainRenderer(event);
      yield* run(() => host.unregister(input.environmentId));
    }),
  }),
  DesktopIpc.makeIpcMethod({
    channel: LOOPBACK_GATEWAY_SET_ENABLED_CHANNEL,
    payload: LoopbackGatewaySetEnabledInput,
    result: Schema.NullOr(LoopbackGatewayStatus),
    handler: Effect.fn("desktop.ipc.loopbackGateway.setEnabled")(function* (input, event) {
      yield* ensureMainRenderer(event);
      return yield* run(() => host.setEnabled(input.environmentId, input.enabled));
    }),
  }),
  DesktopIpc.makeIpcMethod({
    channel: LOOPBACK_GATEWAY_SET_REACHABLE_CHANNEL,
    payload: LoopbackGatewaySetReachableInput,
    result: Schema.NullOr(LoopbackGatewayStatus),
    handler: Effect.fn("desktop.ipc.loopbackGateway.setReachable")(function* (input, event) {
      yield* ensureMainRenderer(event);
      return yield* run(() => host.setReachable(input.environmentId, input.reachable));
    }),
  }),
  DesktopIpc.makeIpcMethod({
    channel: LOOPBACK_GATEWAY_GET_STATUS_CHANNEL,
    payload: LoopbackGatewayEnvironmentInput,
    result: Schema.NullOr(LoopbackGatewayStatus),
    handler: Effect.fn("desktop.ipc.loopbackGateway.getStatus")(function* (input, event) {
      yield* ensureMainRenderer(event);
      return host.getStatus(input.environmentId);
    }),
  }),
];

export const installLoopbackGatewayIpc = Effect.fn("desktop.ipc.loopbackGateway.install")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());

    const host = makeLoopbackGatewayHost({
      emit: (event: LoopbackGatewayEvent) => {
        runFork(electronWindow.sendAll(LOOPBACK_GATEWAY_EVENT_CHANNEL, event));
      },
      renderErrorPage: renderGatewayErrorPage,
    });
    installedHost = host;
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        installedHost = undefined;
        await host.dispose();
      }),
    );

    // Chromium asks for the proxy's password through `login`. Nothing else is ever answered here:
    // no other host, port, session or kind of challenge (design 4.7).
    const answerLogin = makeProxyLoginListener(host);
    yield* app.on(
      "login",
      (
        event: Electron.Event,
        webContents: Electron.WebContents | undefined,
        _details: Electron.AuthenticationResponseDetails,
        authInfo: Electron.AuthInfo,
        callback: (username?: string, password?: string) => void,
      ) => answerLogin(event, webContents, authInfo, callback),
    );

    for (const method of methodsFor(host)) {
      yield* ipc.handle<
        Effect.Error<ReturnType<(typeof method)["handler"]>>,
        Effect.Services<ReturnType<(typeof method)["handler"]>>
      >(method);
    }
  },
);
