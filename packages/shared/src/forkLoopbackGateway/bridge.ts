// fork: the desktop main process's side of the gateway, as the renderer sees it
// (research/remote-loopback-forwarding.md 2.3, 4.2, 7.2, 10). Only the desktop renderer has the
// bridge; the main window's own top frame is the only caller the main process answers.
import * as Schema from "effect/Schema";

import { LoopbackGatewayErrorCode } from "./protocol.ts";

export const LOOPBACK_GATEWAY_BRIDGE_GLOBAL = "t3xLoopbackGatewayBridge";

const EnvironmentId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));

/**
 * The ticket is wrapped as soon as it is decoded in the main process and never logged. Its shape
 * is checked afterwards by the controller (`parseLoopbackGatewayAuthorization`), not by a schema
 * check here: a failed check would put the value into the decoding error's message.
 */
export const LoopbackGatewayCredential = Schema.Struct({
  ticket: Schema.RedactedFromValue(Schema.String),
  expiresAt: Schema.DateTimeUtcFromString,
});
export type LoopbackGatewayCredential = typeof LoopbackGatewayCredential.Type;

/**
 * Installs or updates an environment. The renderer calls it before it creates the environment's
 * first webview, so a proxy is already in place for the first request. `httpBaseUrl` is the route
 * actually in use; changing it re-runs the transport check and drops the previous ticket.
 */
export const LoopbackGatewayRegisterInput = Schema.Struct({
  environmentId: EnvironmentId,
  httpBaseUrl: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  /** `false` when the user turned forwarding off for this environment (`disabled-by-user`). */
  enabled: Schema.Boolean,
  credential: Schema.optionalKey(LoopbackGatewayCredential),
});
export type LoopbackGatewayRegisterInput = typeof LoopbackGatewayRegisterInput.Type;

export const LoopbackGatewayUpdateTicketInput = Schema.Struct({
  environmentId: EnvironmentId,
  credential: LoopbackGatewayCredential,
});
export type LoopbackGatewayUpdateTicketInput = typeof LoopbackGatewayUpdateTicketInput.Type;

export const LoopbackGatewayEnvironmentInput = Schema.Struct({ environmentId: EnvironmentId });
export type LoopbackGatewayEnvironmentInput = typeof LoopbackGatewayEnvironmentInput.Type;

export const LoopbackGatewaySetEnabledInput = Schema.Struct({
  environmentId: EnvironmentId,
  enabled: Schema.Boolean,
});
export type LoopbackGatewaySetEnabledInput = typeof LoopbackGatewaySetEnabledInput.Type;

/** The renderer reports whether it is connected to the environment (design 10, "环境断开"). */
export const LoopbackGatewaySetReachableInput = Schema.Struct({
  environmentId: EnvironmentId,
  reachable: Schema.Boolean,
});
export type LoopbackGatewaySetReachableInput = typeof LoopbackGatewaySetReachableInput.Type;

export const LoopbackGatewayState = Schema.Literals([
  /** A proxy is installed and has no ticket yet: loopback requests get a 503. */
  "pending",
  "active",
  /** The renderer reported the environment disconnected, or the last tunnel could not reach it. */
  "offline",
  "disabled-by-user",
  /** The route fails the transport check (`code` says why): no proxy. */
  "unsupported-route",
  /** The environment refused the ticket or the connection (`code` says why). */
  "rejected",
]);
export type LoopbackGatewayState = typeof LoopbackGatewayState.Type;

export const LoopbackGatewayStatus = Schema.Struct({
  state: LoopbackGatewayState,
  code: Schema.optionalKey(LoopbackGatewayErrorCode),
  /** `unsupported-route` for a plain `100.64.0.0/10` address: suggest MagicDNS or HTTPS. */
  hint: Schema.optionalKey(Schema.Literal("tailscale-address")),
});
export type LoopbackGatewayStatus = typeof LoopbackGatewayStatus.Type;

/** What the main process pushes to the renderer. */
export const LoopbackGatewayEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    environmentId: EnvironmentId,
    status: LoopbackGatewayStatus,
  }),
  /** The ticket expires within a minute, or a request found none: fetch a new one now. */
  Schema.Struct({ type: Schema.Literal("ticket-needed"), environmentId: EnvironmentId }),
  /**
   * A forwarded request was refused (design 7.2). `mainFrame` is true for the error page of a
   * top-level navigation, with the webview's `webContentsId` and the URL; a refused `CONNECT`
   * (https, ws) has neither and only names the port.
   */
  Schema.Struct({
    type: Schema.Literal("denied"),
    environmentId: EnvironmentId,
    code: LoopbackGatewayErrorCode,
    port: Schema.Number,
    mainFrame: Schema.Boolean,
    webContentsId: Schema.optionalKey(Schema.Number),
    url: Schema.optionalKey(Schema.String),
  }),
]);
export type LoopbackGatewayEvent = typeof LoopbackGatewayEvent.Type;

/** The renderer's view of `window.t3xLoopbackGatewayBridge`; arguments are the encoded wire forms. */
export interface LoopbackGatewayBridge {
  readonly register: (
    input: typeof LoopbackGatewayRegisterInput.Encoded,
  ) => Promise<LoopbackGatewayStatus>;
  /** Resolves `null` for every call below when the environment is not registered. */
  readonly updateTicket: (
    input: typeof LoopbackGatewayUpdateTicketInput.Encoded,
  ) => Promise<LoopbackGatewayStatus | null>;
  /** Tears the environment's proxy down and restores its sessions' default networking. */
  readonly unregister: (input: LoopbackGatewayEnvironmentInput) => Promise<void>;
  /** Stops (`false`) or resumes (`true`) forwarding for every tab of the environment. */
  readonly setEnabled: (
    input: LoopbackGatewaySetEnabledInput,
  ) => Promise<LoopbackGatewayStatus | null>;
  readonly setReachable: (
    input: LoopbackGatewaySetReachableInput,
  ) => Promise<LoopbackGatewayStatus | null>;
  readonly getStatus: (
    input: LoopbackGatewayEnvironmentInput,
  ) => Promise<LoopbackGatewayStatus | null>;
  readonly onEvent: (listener: (event: LoopbackGatewayEvent) => void) => () => void;
}
