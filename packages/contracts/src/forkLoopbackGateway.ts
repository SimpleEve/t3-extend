import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  EnvironmentAuthorizationError,
  type AuthWebSocketTicketUse,
} from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// fork: forwarding a remote environment's loopback services to a locally rendered desktop tab
// (research/remote-loopback-forwarding.md). Wire format only; the tunnel route's constants are in
// `@t3tools/shared/forkLoopbackGateway/protocol`.

export const FORK_LOOPBACK_GATEWAY_WS_METHODS = {
  issueTicket: "loopbackGateway.issueTicket",
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

/** Not yet in `WsRpcGroup`: adding it needs the server handler, which lands with the server half. */
export const FORK_LOOPBACK_GATEWAY_RPCS = [WsLoopbackGatewayIssueTicketRpc] as const;

/**
 * The table `CLIENT_GUARDED_RPC_SCOPES` spreads (one scope per method) once the RPC is in
 * `WsRpcGroup`; before that the server's `RPC_REQUIRED_SCOPES` would name an RPC the group lacks.
 * `clientRpcRequiredScopes` returns `LOOPBACK_GATEWAY_REQUIRED_SCOPES` for it either way.
 */
export const FORK_LOOPBACK_GATEWAY_GUARDED_RPC_SCOPES = {
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket]: AuthPreviewOperateScope,
} as const;

/**
 * Metric/trace aggregate label for the method.
 * @public
 */
export const FORK_LOOPBACK_GATEWAY_RPC_AGGREGATES = {
  [FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket]: "loopbackGateway",
} as const;
