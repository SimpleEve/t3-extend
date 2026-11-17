import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  EnvironmentAuthorizationError,
  type AuthWebSocketTicketUse,
} from "./auth.ts";
import { PortSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";

// fork: forwarding a remote environment's loopback services to a locally rendered desktop tab
// (research/remote-loopback-forwarding.md). Wire format only; the tunnel route's constants are in
// `@t3tools/shared/forkLoopbackGateway/protocol`.

export const FORK_LOOPBACK_GATEWAY_WS_METHODS = {
  issueTicket: "loopbackGateway.issueTicket",
  listAllowedPorts: "loopbackGateway.listAllowedPorts",
  allowPort: "loopbackGateway.allowPort",
  removeAllowedPort: "loopbackGateway.removeAllowedPort",
} as const;

/** The only audience the tunnel route accepts (design 4.4); tickets with none or another are refused. */
export const LOOPBACK_GATEWAY_TICKET_AUDIENCE =
  "loopback-gateway" as const satisfies AuthWebSocketTicketUse;

/**
 * A tunnel reaches processes that terminals and agents started, so it needs the terminal's grant as
 * well as the preview's (design 4.5). The RPC and the tunnel route both enforce all of them.
 */
export const LOOPBACK_GATEWAY_REQUIRED_SCOPES = [
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
] as const;

export const LoopbackGatewayIssueTicketInput = Schema.Struct({});
export type LoopbackGatewayIssueTicketInput = typeof LoopbackGatewayIssueTicketInput.Type;

export const LoopbackGatewayIssueTicketResult = Schema.Struct({
  /** Sent as `Authorization: T3X-Gateway <ticket>`; reusable until `expiresAt`. */
  ticket: Schema.RedactedFromValue(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type LoopbackGatewayIssueTicketResult = typeof LoopbackGatewayIssueTicketResult.Type;

export const LoopbackGatewayUnavailableReason = Schema.Literals([
  /** `T3CODE_PORT_DISCOVERY=0`. */
  "discovery-disabled",
  /** The host platform does not advertise the capability (Windows, unverified Linux). */
  "unsupported-platform",
  /** 30 tickets per minute per session. */
  "rate-limited",
]);
export type LoopbackGatewayUnavailableReason = typeof LoopbackGatewayUnavailableReason.Type;

export class LoopbackGatewayUnavailableError extends Schema.TaggedError<LoopbackGatewayUnavailableError>()(
  "LoopbackGatewayUnavailableError",
  {
    reason: LoopbackGatewayUnavailableReason,
    message: Schema.String,
  },
) {}

const LoopbackGatewayRpcError = Schema.Union([
  LoopbackGatewayUnavailableError,
  EnvironmentAuthorizationError,
]);

const WsLoopbackGatewayIssueTicketRpc = Rpc.make(FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket, {
  payload: LoopbackGatewayIssueTicketInput,
  success: LoopbackGatewayIssueTicketResult,
  error: LoopbackGatewayRpcError,
});

/**
 * A port the user allowed by hand: the service on it was not started by a terminal or an agent, so
 * the ownership rules refuse it, and the user chose to forward it anyway. Kept on the environment
 * and shared by every device and session of it.
 */
export const LoopbackGatewayAllowedPort = Schema.Struct({
  port: PortSchema,
  allowedAt: Schema.DateTimeUtc,
});
export type LoopbackGatewayAllowedPort = typeof LoopbackGatewayAllowedPort.Type;

/** The whole list after the call, so a caller never has to guess what a change did. */
export const LoopbackGatewayAllowedPortsResult = Schema.Struct({
  ports: Schema.Array(LoopbackGatewayAllowedPort),
});
export type LoopbackGatewayAllowedPortsResult = typeof LoopbackGatewayAllowedPortsResult.Type;

export const LoopbackGatewayListAllowedPortsInput = Schema.Struct({});
export type LoopbackGatewayListAllowedPortsInput = typeof LoopbackGatewayListAllowedPortsInput.Type;

/** An integer here, not `PortSchema`, so an out-of-range port is a typed `invalid-port` and not a decode failure. */
export const LoopbackGatewayAllowedPortInput = Schema.Struct({ port: Schema.Int });
export type LoopbackGatewayAllowedPortInput = typeof LoopbackGatewayAllowedPortInput.Type;

export const LoopbackGatewayAllowedPortFailure = Schema.Literals([
  /** Not 1 to 65535. */
  "invalid-port",
  /** A debugger or container socket port, or the port of this server itself. */
  "reserved",
  /** The list is full (64). */
  "limit-reached",
  /** The list could not be written to disk, so nothing changed. */
  "not-saved",
]);
export type LoopbackGatewayAllowedPortFailure = typeof LoopbackGatewayAllowedPortFailure.Type;

export class LoopbackGatewayAllowedPortError extends Schema.TaggedError<LoopbackGatewayAllowedPortError>()(
  "LoopbackGatewayAllowedPortError",
  {
    reason: LoopbackGatewayAllowedPortFailure,
    message: Schema.String,
  },
) {}

const LoopbackGatewayAllowedPortRpcError = Schema.Union([
  LoopbackGatewayAllowedPortError,
  EnvironmentAuthorizationError,
]);

const WsLoopbackGatewayListAllowedPortsRpc = Rpc.make(
  FORK_LOOPBACK_GATEWAY_WS_METHODS.listAllowedPorts,
  {
    payload: LoopbackGatewayListAllowedPortsInput,
    success: LoopbackGatewayAllowedPortsResult,
    error: EnvironmentAuthorizationError,
  },
);

// There is deliberately no MCP tool for these: allowing a port is something the user does in the
// interface, never something an agent can do for itself.
const WsLoopbackGatewayAllowPortRpc = Rpc.make(FORK_LOOPBACK_GATEWAY_WS_METHODS.allowPort, {
  payload: LoopbackGatewayAllowedPortInput,
  success: LoopbackGatewayAllowedPortsResult,
  error: LoopbackGatewayAllowedPortRpcError,
});

const WsLoopbackGatewayRemoveAllowedPortRpc = Rpc.make(
  FORK_LOOPBACK_GATEWAY_WS_METHODS.removeAllowedPort,
  {
    payload: LoopbackGatewayAllowedPortInput,
    success: LoopbackGatewayAllowedPortsResult,
    error: LoopbackGatewayAllowedPortRpcError,
  },
);

export const FORK_LOOPBACK_GATEWAY_RPCS = [
  WsLoopbackGatewayIssueTicketRpc,
  WsLoopbackGatewayListAllowedPortsRpc,
  WsLoopbackGatewayAllowPortRpc,
  WsLoopbackGatewayRemoveAllowedPortRpc,
] as const;

/**
 * The table `CLIENT_GUARDED_RPC_SCOPES` spreads (one scope per method).
 * `clientRpcRequiredScopes` returns `LOOPBACK_GATEWAY_REQUIRED_SCOPES` for each of them, so every
 * method needs the preview and the terminal grant together.
 */
export const FORK_LOOPBACK_GATEWAY_GUARDED_RPC_SCOPES = {
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket]: AuthPreviewOperateScope,
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.listAllowedPorts]: AuthPreviewOperateScope,
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.allowPort]: AuthPreviewOperateScope,
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.removeAllowedPort]: AuthPreviewOperateScope,
} as const;

/**
 * Metric/trace aggregate label for the method.
 * @public
 */
export const FORK_LOOPBACK_GATEWAY_RPC_AGGREGATES = {
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket]: "loopbackGateway",
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.listAllowedPorts]: "loopbackGateway",
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.allowPort]: "loopbackGateway",
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.removeAllowedPort]: "loopbackGateway",
} as const;
