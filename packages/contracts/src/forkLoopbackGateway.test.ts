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
  LoopbackGatewayAllowedPortError,
  LoopbackGatewayAllowedPortInput,
  LoopbackGatewayAllowedPortsResult,
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
const allowedCodec = Schema.toCodecJson(LoopbackGatewayAllowedPortsResult);
const decodeAllowed = Schema.decodeUnknownSync(allowedCodec);
const encodeAllowed = Schema.encodeSync(allowedCodec);
const decodePortInput = Schema.decodeUnknownSync(LoopbackGatewayAllowedPortInput);
const allowedPortErrorCodec = Schema.toCodecJson(LoopbackGatewayAllowedPortError);
const decodeAllowedPortError = Schema.decodeUnknownSync(allowedPortErrorCodec);
const encodeAllowedPortError = Schema.encodeSync(allowedPortErrorCodec);
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

  it("names its RPCs, all behind the preview scope that the terminal scope joins", () => {
    expect(FORK_LOOPBACK_GATEWAY_RPCS.map((rpc) => rpc._tag)).toEqual(
      Object.values(FORK_LOOPBACK_GATEWAY_WS_METHODS),
    );
    expect(isTicketUse(LOOPBACK_GATEWAY_TICKET_AUDIENCE)).toBe(true);
    expect(FORK_LOOPBACK_GATEWAY_GUARDED_RPC_SCOPES).toEqual({
      [FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket]: AuthPreviewOperateScope,
      [FORK_LOOPBACK_GATEWAY_WS_METHODS.listAllowedPorts]: AuthPreviewOperateScope,
      [FORK_LOOPBACK_GATEWAY_WS_METHODS.allowPort]: AuthPreviewOperateScope,
      [FORK_LOOPBACK_GATEWAY_WS_METHODS.removeAllowedPort]: AuthPreviewOperateScope,
    });
    expect(LOOPBACK_GATEWAY_REQUIRED_SCOPES).toEqual([
      AuthPreviewOperateScope,
      AuthTerminalOperateScope,
    ]);
  });

  it("round-trips the allowed ports; a port the server will judge is any integer", () => {
    const wire: unknown = {
      ports: [{ port: 7733, allowedAt: "2026-11-17T08:00:00.000Z" }],
    };
    expect(encodeAllowed(decodeAllowed(wire))).toEqual(wire);
    const outOfRange: unknown = { ports: [{ port: 0, allowedAt: "2026-11-17T08:00:00.000Z" }] };
    expect(() => decodeAllowed(outOfRange)).toThrow();
    const wide: unknown = { port: 70000 };
    expect(decodePortInput(wide)).toEqual({ port: 70000 });
    const fractional: unknown = { port: 80.5 };
    expect(() => decodePortInput(fractional)).toThrow();
    const error = new LoopbackGatewayAllowedPortError({ reason: "reserved", message: "Reserved." });
    const wireError: unknown = encodeAllowedPortError(error);
    expect(decodeAllowedPortError(wireError)).toEqual(error);
  });
});
