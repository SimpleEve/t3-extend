import { describe, expect, it } from "vite-plus/test";

import {
  displayHostForUnspecified,
  displayUrlForUnspecified,
  isLoopbackGatewayHost,
} from "./hosts.ts";

// Design 1.2: the spellings Chromium canonicalizes to, as the proxy sees them.
const LOOPBACK = [
  "localhost",
  "LOCALHOST",
  "localhost.",
  "app.localhost",
  "a.b.localhost.",
  "127.0.0.1",
  "127.0.0.2",
  "127.255.255.254",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
  "[0:0:0:0:0:0:0:1]",
  "[::ffff:7f00:1]",
  "::ffff:127.0.0.1",
  "[::ffff:127.255.255.254]",
  "[::FFFF:7F00:1]",
];

const NOT_LOOPBACK = [
  // Not routed to the proxy by Chromium, so never forwarded.
  "0.0.0.0",
  "[::]",
  "::",
  "localhost.localdomain",
  // Looks like loopback, is not.
  "127.0.0.1.evil.com",
  "evil.com",
  "notlocalhost",
  "foo.localhost.evil.com",
  "xlocalhost",
  "a..localhost",
  ".localhost",
  "localhost..",
  "localhost@evil.com",
  "localhost:5173",
  "127.0.0.1:5173",
  "http://localhost",
  "localhost/",
  // Not canonical: Chromium rewrites these before the proxy, so the proxy never sees them.
  "127.1",
  "2130706433",
  "0x7f.0.0.1",
  "127.0.0.01",
  "127.0.0.256",
  "127.0.0",
  // IPv6 that is not ::1 or a 127/8 mapping.
  "[::2]",
  "[::ffff:128.0.0.1]",
  "[::ffff:7e00:1]",
  "[::1:1]",
  "[fe80::1%en0]",
  "[::ffff:127.0.0.1",
  "::1]",
  "[:::1]",
  "[1::2::3]",
  "[::ffff:127.0.0]",
  "10.0.0.1",
  "192.168.1.1",
  "",
  ".",
];

describe("isLoopbackGatewayHost", () => {
  it.each(LOOPBACK)("forwards %s", (host) => {
    expect(isLoopbackGatewayHost(host)).toBe(true);
  });

  it.each(NOT_LOOPBACK)("refuses %j", (host) => {
    expect(isLoopbackGatewayHost(host)).toBe(false);
  });

  it("agrees with how WHATWG URL spells the hosts Chromium sends", () => {
    for (const [url, expected] of [
      ["http://LOCALHOST:5173/", true],
      ["http://localhost.:5173/", true],
      ["http://127.1:5173/", true],
      ["http://2130706433:5173/", true],
      ["http://0x7f.0.0.1:5173/", true],
      ["http://[0:0:0:0:0:0:0:1]:5173/", true],
      ["http://[::ffff:127.0.0.1]:5173/", true],
      ["http://0.0.0.0:5173/", false],
      ["http://[::]:5173/", false],
      ["http://localhost.localdomain:5173/", false],
      ["http://localhost@evil.com/", false],
    ] as const) {
      expect([url, isLoopbackGatewayHost(new URL(url).hostname)]).toEqual([url, expected]);
    }
  });
});

describe("display rewrite", () => {
  it.each([
    ["0.0.0.0", "localhost"],
    ["[::]", "localhost"],
    ["::", "localhost"],
    ["[0:0:0:0:0:0:0:0]", "localhost"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["0.0.0.1", "0.0.0.1"],
    ["example.com", "example.com"],
  ])("displays %s as %s", (host, shown) => {
    expect(displayHostForUnspecified(host)).toBe(shown);
  });

  it.each([
    ["http://0.0.0.0:5173/a?b=1#c", "http://localhost:5173/a?b=1#c"],
    ["https://[::]:8443/", "https://localhost:8443/"],
    ["http://0/", "http://localhost/"],
    ["http://localhost:5173/", "http://localhost:5173/"],
    ["http://127.0.0.1:5173/x", "http://127.0.0.1:5173/x"],
    ["not a url", "not a url"],
    ["file:///tmp/x", "file:///tmp/x"],
  ])("rewrites %s to %s", (url, shown) => {
    expect(displayUrlForUnspecified(url)).toBe(shown);
  });

  it("never makes an unspecified address pass the security check", () => {
    for (const host of ["0.0.0.0", "[::]"]) {
      expect(isLoopbackGatewayHost(displayHostForUnspecified(host))).toBe(true);
      expect(isLoopbackGatewayHost(host)).toBe(false);
    }
  });
});
