import { describe, expect, it } from "vite-plus/test";

import {
  isLoopbackGatewayReady,
  type LoopbackGatewayInputs,
  type LoopbackGatewayState,
  resolveLoopbackGatewayState,
} from "./gatewayState";

const READY: LoopbackGatewayInputs = {
  hasBridge: true,
  runsOnThisComputer: false,
  route: { httpBaseUrl: "https://box.example.com", relay: false },
  capability: true,
  permission: true,
  disabledByUser: false,
};

const resolve = (overrides: Partial<LoopbackGatewayInputs>) =>
  resolveLoopbackGatewayState({ ...READY, ...overrides });

describe("loopback gateway state", () => {
  // Each row changes the all-clear input in one way: the first gate that fails is the answer.
  const gates: ReadonlyArray<
    readonly [string, Partial<LoopbackGatewayInputs>, LoopbackGatewayState]
  > = [
    ["every gate open", {}, { state: "active" }],
    ["no bridge: web and mobile", { hasBridge: false }, { state: "not-applicable" }],
    ["this computer's own server", { runsOnThisComputer: true }, { state: "not-applicable" }],
    ["capability missing", { capability: false }, { state: "unsupported-server" }],
    [
      "route through the relay",
      { route: { httpBaseUrl: "https://relay.example.com", relay: true } },
      { state: "unsupported-route", reason: "relay" },
    ],
    [
      "plain LAN address",
      { route: { httpBaseUrl: "http://192.168.1.5:3873", relay: false } },
      { state: "unsupported-route", reason: "insecure-transport" },
    ],
    [
      "plain Tailscale IPv4 address",
      { route: { httpBaseUrl: "http://100.101.102.103:3873", relay: false } },
      { state: "unsupported-route", reason: "insecure-transport", hint: "tailscale-address" },
    ],
    [
      "plain MagicDNS name",
      { route: { httpBaseUrl: "http://mac.tail1234.ts.net:3873", relay: false } },
      { state: "active" },
    ],
    [
      "SSH forward on loopback",
      { route: { httpBaseUrl: "http://127.0.0.1:50123", relay: false } },
      { state: "active" },
    ],
    [
      "unusable address",
      { route: { httpBaseUrl: "not a url", relay: false } },
      { state: "not-applicable" },
    ],
    ["missing scopes", { permission: false }, { state: "no-permission" }],
    ["turned off by the user", { disabledByUser: true }, { state: "disabled-by-user" }],
  ];
  it.each(gates)("%s", (_name, overrides, expected) => {
    expect(resolve(overrides)).toEqual(expected);
  });

  // The order is the order a user would fix things in; the user's own switch is last.
  const priorities: ReadonlyArray<
    readonly [string, Partial<LoopbackGatewayInputs>, LoopbackGatewayState["state"]]
  > = [
    [
      "no bridge beats everything",
      { hasBridge: false, capability: false, permission: false, disabledByUser: true },
      "not-applicable",
    ],
    [
      "local beats an old server",
      { runsOnThisComputer: true, capability: false },
      "not-applicable",
    ],
    [
      "old server beats relay",
      { capability: false, route: { httpBaseUrl: "https://r.example.com", relay: true } },
      "unsupported-server",
    ],
    [
      "relay beats missing scopes",
      { route: { httpBaseUrl: "https://r.example.com", relay: true }, permission: false },
      "unsupported-route",
    ],
    [
      "plain route beats missing scopes",
      { route: { httpBaseUrl: "http://10.0.0.5", relay: false }, permission: false },
      "unsupported-route",
    ],
    [
      "missing scopes beat the user's switch",
      { permission: false, disabledByUser: true },
      "no-permission",
    ],
    [
      "a plain route hides the user's switch",
      { route: { httpBaseUrl: "http://10.0.0.5", relay: false }, disabledByUser: true },
      "unsupported-route",
    ],
    [
      "an old server hides the user's switch",
      { capability: false, disabledByUser: true },
      "unsupported-server",
    ],
  ];
  it.each(priorities)("%s", (_name, overrides, expected) => {
    expect(resolve(overrides).state).toBe(expected);
  });

  // Until an input is known the answer is open, but a gate that already failed still decides.
  const unknowns: ReadonlyArray<
    readonly [string, Partial<LoopbackGatewayInputs>, LoopbackGatewayState["state"]]
  > = [
    ["configuration not loaded", { capability: null }, "unknown"],
    ["no route yet", { route: null }, "unknown"],
    ["session not loaded", { permission: null }, "unknown"],
    ["old server before a route exists", { capability: false, route: null }, "unsupported-server"],
    [
      "plain route before the session loads",
      { route: { httpBaseUrl: "http://10.0.0.5", relay: false }, permission: null },
      "unsupported-route",
    ],
    [
      "local needs nothing loaded",
      { runsOnThisComputer: true, capability: null, route: null, permission: null },
      "not-applicable",
    ],
  ];
  it.each(unknowns)("%s", (_name, overrides, expected) => {
    expect(resolve(overrides).state).toBe(expected);
  });
});

describe("loopback gateway ready", () => {
  type Input = Parameters<typeof isLoopbackGatewayReady>[0];
  const rows: ReadonlyArray<readonly [string, Input, boolean]> = [
    [
      "forwarded, not registered yet",
      { state: "active", connecting: true, registration: "pending" },
      false,
    ],
    [
      "forwarded, manager has not seen it yet",
      { state: "active", connecting: true, registration: undefined },
      false,
    ],
    [
      "forwarded and registered",
      { state: "active", connecting: true, registration: "registered" },
      true,
    ],
    [
      "forwarded, registration failed",
      { state: "active", connecting: true, registration: "failed" },
      true,
    ],
    [
      "unknown while connecting",
      { state: "unknown", connecting: true, registration: undefined },
      false,
    ],
    [
      "unknown, nothing connecting",
      { state: "unknown", connecting: false, registration: undefined },
      true,
    ],
    [
      "stopped by the user",
      { state: "disabled-by-user", connecting: true, registration: undefined },
      true,
    ],
    [
      "plain route",
      { state: "unsupported-route", connecting: true, registration: undefined },
      true,
    ],
    [
      "this computer's own server",
      { state: "not-applicable", connecting: false, registration: undefined },
      true,
    ],
  ];
  it.each(rows)("%s", (_name, input, expected) => {
    expect(isLoopbackGatewayReady(input)).toBe(expected);
  });
});
