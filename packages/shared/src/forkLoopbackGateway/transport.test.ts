import { describe, expect, it } from "vite-plus/test";

import { isTailnetHost } from "../hostClassification.ts";
import { buildLoopbackGatewayTunnelUrl, checkLoopbackGatewayTransport } from "./transport.ts";

const insecure = { ok: false, reason: "insecure-transport" } as const;
const invalid = { ok: false, reason: "invalid-url" } as const;
const via = (kind: "tls" | "loopback" | "tailnet") => ({
  ok: true,
  via: kind,
  tunnelProtocol: kind === "tls" ? "wss:" : "ws:",
});

// Design 4.6, row by row.
const ROWS: ReadonlyArray<readonly [string, unknown]> = [
  ["https://x.t3.example.com", via("tls")],
  ["https://192.168.1.5:3873", via("tls")],
  ["https://[2001:db8::1]", via("tls")],
  ["http://127.0.0.1:3999", via("loopback")],
  ["http://localhost:3999", via("loopback")],
  ["http://LOCALHOST.:3999", via("loopback")],
  ["http://app.localhost:3999", via("loopback")],
  ["http://127.255.255.254:3999", via("loopback")],
  ["http://[::1]:3999", via("loopback")],
  ["http://[::ffff:127.0.0.1]:3999", via("loopback")],
  ["http://mac.tail1234.ts.net:3873", via("tailnet")],
  ["http://MAC.TAIL1234.TS.NET.:3873", via("tailnet")],
  ["http://[fd7a:115c:a1e0::1234]:3873", via("tailnet")],
  ["http://[fd7a:115c:a1e0:ffff::1]", via("tailnet")],
  ["http://[fd7a:115c:a1e1::1]", insecure],
  ["http://[fd7a:115c:a1df::1]", insecure],
  // A plain 100.64.0.0/10 address is not Tailscale; the hint says what to use instead.
  ["http://100.64.0.1", { ...insecure, hint: "tailscale-address" }],
  ["http://100.101.102.103:3873", { ...insecure, hint: "tailscale-address" }],
  ["http://100.127.255.255", { ...insecure, hint: "tailscale-address" }],
  ["http://100.63.255.255", insecure],
  ["http://100.128.0.1", insecure],
  ["http://evil.ts.net.example.com", insecure],
  ["http://ts.net", insecure],
  ["http://notts.net", insecure],
  ["http://ts.net.evil.com", insecure],
  ["http://192.168.1.10:3873", insecure],
  ["http://10.0.0.5", insecure],
  ["http://172.16.0.1", insecure],
  ["http://169.254.1.1", insecure],
  ["http://mac-mini:3873", insecure],
  ["http://mac-mini.local:3873", insecure],
  ["http://home.arpa", insecure],
  ["http://example.com", insecure],
  ["http://127.0.0.1.evil.com", insecure],
  ["http://localhost@evil.com", insecure],
  ["http://0.0.0.0:3999", insecure],
  ["http://[::]:3999", insecure],
  ["ftp://x", invalid],
  ["ws://127.0.0.1:3999", invalid],
  ["not a url", invalid],
  ["", invalid],
];

describe("checkLoopbackGatewayTransport", () => {
  it.each(ROWS)("%j", (httpBaseUrl, expected) => {
    expect(checkLoopbackGatewayTransport(httpBaseUrl)).toEqual(expected);
  });

  it("only ever calls a plain-http host tailnet when the upstream check does", () => {
    for (const host of ["a.ts.net", "a.b.ts.net.", "[fd7a:115c:a1e0::1]", "ts.net", "100.64.0.1"]) {
      const result = checkLoopbackGatewayTransport(`http://${host}`);
      expect(result.ok && result.via === "tailnet").toBe(
        isTailnetHost(new URL(`http://${host}`).hostname),
      );
    }
  });
});

describe("buildLoopbackGatewayTunnelUrl", () => {
  it.each([
    ["https://b.example.com", 5173, "wss://b.example.com/api/loopback-gateway/tunnel?port=5173"],
    [
      "https://b.example.com:8443/",
      80,
      "wss://b.example.com:8443/api/loopback-gateway/tunnel?port=80",
    ],
    ["http://127.0.0.1:3999", 5173, "ws://127.0.0.1:3999/api/loopback-gateway/tunnel?port=5173"],
    [
      "http://mac.tail1234.ts.net:3873/",
      3000,
      "ws://mac.tail1234.ts.net:3873/api/loopback-gateway/tunnel?port=3000",
    ],
    [
      "https://user:pw@b.example.com",
      5173,
      "wss://b.example.com/api/loopback-gateway/tunnel?port=5173",
    ],
    ["http://192.168.1.10:3873", 5173, null],
    ["not a url", 5173, null],
  ])("%s port %d", (httpBaseUrl, port, expected) => {
    expect(buildLoopbackGatewayTunnelUrl(httpBaseUrl, port)).toBe(expected);
  });
});
