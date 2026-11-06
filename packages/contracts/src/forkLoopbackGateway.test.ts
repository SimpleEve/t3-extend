import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  AuthWebSocketTicketUse,
} from "./auth.ts";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import {
  FORK_LOOPBACK_GATEWAY_GUARDED_RPC_SCOPES,
  FORK_LOOPBACK_GATEWAY_RPCS,
  FORK_LOOPBACK_GATEWAY_WS_METHODS,
  LOOPBACK_GATEWAY_REQUIRED_SCOPES,
  LOOPBACK_GATEWAY_TICKET_AUDIENCE,
  LoopbackGatewayIssueTicketInput,
  LoopbackGatewayIssueTicketResult,
  LoopbackGatewayUnavailableError,
} from "./forkLoopbackGateway.ts";

const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);
const decodeInput = Schema.decodeUnknownSync(LoopbackGatewayIssueTicketInput);
const isTicketUse = Schema.is(AuthWebSocketTicketUse);
const ticketCodec = Schema.toCodecJson(LoopbackGatewayIssueTicketResult);
const decodeTicket = Schema.decodeUnknownSync(ticketCodec);
const encodeTicket = Schema.encodeSync(ticketCodec);
const errorCodec = Schema.toCodecJson(LoopbackGatewayUnavailableError);
const decodeError = Schema.decodeUnknownSync(errorCodec);
const encodeError = Schema.encodeSync(errorCodec);

describe("loopback gateway contract", () => {
  it("round-trips a ticket without printing it", () => {
    const wire: unknown = { ticket: "payload.signature", expiresAt: "2026-11-04T12:05:00.000Z" };
    const decoded = decodeTicket(wire);
    expect(Redacted.value(decoded.ticket)).toBe("payload.signature");
    expect(String(decoded.ticket)).not.toContain("payload");
    expect(encodeTicket(decoded)).toEqual(wire);
    const blank: unknown = { ticket: "  ", expiresAt: "2026-11-04T12:05:00.000Z" };
    expect(() => decodeTicket(blank)).toThrow();
    expect(decodeInput({})).toEqual({});
  });

  it("round-trips the unavailable error and rejects other reasons", () => {
    const error = new LoopbackGatewayUnavailableError({
      reason: "discovery-disabled",
      message: "Port discovery is off.",
    });
    expect(decodeError(encodeError(error))).toEqual(error);
    const unknown: unknown = { ...(encodeError(error) as object), reason: "because" };
    expect(() => decodeError(unknown)).toThrow();
  });

  it("reads the capability as optional, so older servers still decode", () => {
    expect(decodeCapabilities({ repositoryIdentity: true }).loopbackGateway).toBeUndefined();
    expect(
      decodeCapabilities({ repositoryIdentity: true, loopbackGateway: true }).loopbackGateway,
    ).toBe(true);
  });

  it("names one RPC and keeps the ticket audience a valid ticket use", () => {
    expect(FORK_LOOPBACK_GATEWAY_RPCS.map((rpc) => rpc._tag)).toEqual([
      FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket,
    ]);
    expect(isTicketUse(LOOPBACK_GATEWAY_TICKET_AUDIENCE)).toBe(true);
    expect(FORK_LOOPBACK_GATEWAY_GUARDED_RPC_SCOPES).toEqual({
      [FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket]: AuthPreviewOperateScope,
    });
    expect(LOOPBACK_GATEWAY_REQUIRED_SCOPES).toEqual([
      AuthPreviewOperateScope,
      AuthTerminalOperateScope,
    ]);
  });
});
