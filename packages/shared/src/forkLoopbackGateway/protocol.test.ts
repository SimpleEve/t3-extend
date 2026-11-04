import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  LOOPBACK_GATEWAY_AUTH_SCHEME,
  LOOPBACK_GATEWAY_BLOCKED_PORTS,
  LOOPBACK_GATEWAY_ERROR_CODES,
  LOOPBACK_GATEWAY_LIMITS,
  LOOPBACK_GATEWAY_MAX_TICKET_LENGTH,
  LOOPBACK_GATEWAY_PING_INTERVAL_MS,
  LOOPBACK_GATEWAY_PONG_TIMEOUT_MS,
  LOOPBACK_GATEWAY_SERVER_ERROR_STATUS,
  LoopbackGatewayErrorBody,
  formatLoopbackGatewayAuthorization,
  parseLoopbackGatewayAuthorization,
  parseLoopbackGatewayPort,
} from "./protocol.ts";

const TICKET = "eyJhdWQiOiJsb29wYmFjay1nYXRld2F5In0.dGVzdC1zaWduYXR1cmU";

describe("Authorization scheme", () => {
  it("round-trips a ticket", () => {
    expect(LOOPBACK_GATEWAY_AUTH_SCHEME).toBe("T3X-Gateway");
    expect(formatLoopbackGatewayAuthorization(TICKET)).toBe(`T3X-Gateway ${TICKET}`);
    expect(parseLoopbackGatewayAuthorization(formatLoopbackGatewayAuthorization(TICKET))).toBe(
      TICKET,
    );
  });

  it.each([
    [undefined, null],
    ["", null],
    ["T3X-Gateway", null],
    ["T3X-Gateway ", null],
    [`Bearer ${TICKET}`, null],
    [`DPoP ${TICKET}`, null],
    [`Basic ${TICKET}`, null],
    [TICKET, null],
    // Only the exact scheme, spelled exactly.
    [`t3x-gateway ${TICKET}`, null],
    [`T3X-GATEWAY ${TICKET}`, null],
    [`T3X-Gateway2 ${TICKET}`, null],
    [` T3X-Gateway ${TICKET}`, null],
    // One credential, one space, no trailing junk.
    [`T3X-Gateway  ${TICKET}`, null],
    [`T3X-Gateway ${TICKET} `, null],
    [`T3X-Gateway ${TICKET}, Bearer other`, null],
    [`T3X-Gateway ${TICKET} other`, null],
    [`T3X-Gateway ${TICKET}\n`, null],
    [`T3X-Gateway a"b`, null],
    [`T3X-Gateway ${"a".repeat(LOOPBACK_GATEWAY_MAX_TICKET_LENGTH + 1)}`, null],
  ])("reads %j as %j", (header, expected) => {
    expect(parseLoopbackGatewayAuthorization(header)).toBe(expected);
  });

  it("accepts the longest ticket", () => {
    const longest = "a".repeat(LOOPBACK_GATEWAY_MAX_TICKET_LENGTH);
    expect(parseLoopbackGatewayAuthorization(`T3X-Gateway ${longest}`)).toBe(longest);
  });
});

describe("port parameter", () => {
  it.each([
    ["1", 1],
    ["5173", 5173],
    ["65535", 65535],
    ["65536", null],
    ["0", null],
    ["05173", null],
    ["-1", null],
    ["+80", null],
    ["80.0", null],
    ["8 0", null],
    [" 80", null],
    ["0x50", null],
    ["1e3", null],
    ["123456", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("reads %j as %j", (value, expected) => {
    expect(parseLoopbackGatewayPort(value)).toBe(expected);
  });
});

describe("constants", () => {
  it("blocks the eight debugger and container ports of design 5.7", () => {
    expect([...LOOPBACK_GATEWAY_BLOCKED_PORTS].toSorted((a, b) => a - b)).toEqual([
      2375, 2376, 5005, 5678, 5858, 5859, 9222, 9229,
    ]);
  });

  it("keeps the limits of design 3.7", () => {
    expect(LOOPBACK_GATEWAY_LIMITS).toEqual({
      tunnelsPerSession: 64,
      tunnelsPerServer: 256,
      tunnelOpenBurst: 60,
      tunnelOpenRefillPerSecond: 30,
      ticketsPerSessionPerMinute: 30,
      proxyConnectionsPerEnvironment: 256,
      pendingTunnelOpensPerEnvironment: 32,
      unauthenticatedProxyConnections: 8,
      unauthenticatedProxyConnectionsPerSecond: 20,
      httpConnectionsPerPort: 16,
      httpIdleTimeoutMs: 30_000,
      tunnelSendBufferBytes: 1_048_576,
      readChunkBytes: 65_536,
      maxMessageBytes: 1_048_576,
    });
  });

  it("pings every 30 seconds and gives up after 90 seconds without a pong", () => {
    expect(LOOPBACK_GATEWAY_PING_INTERVAL_MS).toBe(30_000);
    expect(LOOPBACK_GATEWAY_PONG_TIMEOUT_MS).toBe(90_000);
  });

  it("has every error code of design 7.2, each once", () => {
    expect(new Set(LOOPBACK_GATEWAY_ERROR_CODES).size).toBe(LOOPBACK_GATEWAY_ERROR_CODES.length);
    for (const code of [
      "not-owned",
      "reserved",
      "upstream-refused",
      "offline",
      "forbidden",
      "unsupported-server",
      "unsupported-route",
      "insecure-transport",
      "tls-untrusted",
      "discovery-disabled",
      "limit-reached",
      "rate-limited",
      "debug-process",
      "owner-changed",
    ]) {
      expect(LOOPBACK_GATEWAY_ERROR_CODES).toContain(code);
    }
  });
});

describe("error body", () => {
  const decode = Schema.decodeUnknownSync(LoopbackGatewayErrorBody);
  const encode = Schema.encodeSync(LoopbackGatewayErrorBody);

  it("round-trips every code with and without a message", () => {
    for (const code of LOOPBACK_GATEWAY_ERROR_CODES) {
      expect(decode(encode({ code }))).toEqual({ code });
      expect(decode(encode({ code, message: "denied" }))).toEqual({ code, message: "denied" });
    }
  });

  it("refuses unknown codes and bodies without one", () => {
    expect(() => decode({ code: "teapot" })).toThrow();
    expect(() => decode({ message: "no code" })).toThrow();
    expect(() => decode("upstream-refused")).toThrow();
  });

  it("maps every server code to an HTTP error status", () => {
    for (const status of Object.values(LOOPBACK_GATEWAY_SERVER_ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    expect(LOOPBACK_GATEWAY_SERVER_ERROR_STATUS["upstream-refused"]).toBe(502);
    expect(LOOPBACK_GATEWAY_SERVER_ERROR_STATUS["rate-limited"]).toBe(429);
  });
});
