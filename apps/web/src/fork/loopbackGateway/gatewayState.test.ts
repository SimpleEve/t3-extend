import { describe, expect, it } from "vite-plus/test";

import {
  type GateLatch,
  isLoopbackGatewayHeld,
  isLoopbackGatewayReady,
  type LoopbackGatewayInputs,
  type LoopbackGatewayState,
  nextGateLatch,
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
  const base: Input = {
    state: "active",
    connecting: true,
    registration: "registered",
    wasActive: false,
    disabledByUser: false,
  };
  const rows: ReadonlyArray<readonly [string, Partial<Input>, boolean]> = [
    ["forwarded, not registered yet", { registration: "pending" }, false],
    ["forwarded, manager has not seen it yet", { registration: undefined }, false],
    ["forwarded and registered", {}, true],
    ["forwarded, registration failed", { registration: "failed" }, false],
    [
      "forwarded, registration failed, user switched off",
      { registration: "failed", disabledByUser: true },
      true,
    ],
    ["unknown while connecting", { state: "unknown", registration: undefined }, false],
    [
      "unknown, nothing connecting",
      { state: "unknown", connecting: false, registration: undefined },
      true,
    ],
    ["stopped by the user", { state: "disabled-by-user", registration: undefined }, true],
    ["plain route", { state: "unsupported-route", registration: undefined }, true],
    [
      "this computer's own server",
      { state: "not-applicable", connecting: false, registration: undefined },
      true,
    ],
    // An environment that was forwarding does not open its tabs on this computer's localhost.
    [
      "was forwarding, unknown while connecting",
      { state: "unknown", wasActive: true, registration: undefined },
      false,
    ],
    [
      "was forwarding, unknown and unreachable",
      { state: "unknown", wasActive: true, connecting: false, registration: undefined },
      false,
    ],
    ["was forwarding, now known to forward", { wasActive: true, registration: "pending" }, false],
    ["was forwarding, now registered", { wasActive: true }, true],
    [
      "was forwarding, now known not to",
      { state: "unsupported-server", wasActive: true, registration: undefined },
      true,
    ],
    [
      "was forwarding, now no permission",
      { state: "no-permission", wasActive: true, registration: undefined },
      true,
    ],
    [
      "was forwarding, stopped by the user",
      { state: "disabled-by-user", wasActive: true, registration: undefined },
      true,
    ],
    // The user's own switch opens the tab even while the state is still unknown.
    [
      "was forwarding, unreachable, user switched off",
      {
        state: "unknown",
        wasActive: true,
        connecting: false,
        disabledByUser: true,
        registration: undefined,
      },
      true,
    ],
  ];
  it.each(rows)("%s", (_name, overrides, expected) => {
    expect(isLoopbackGatewayReady({ ...base, ...overrides })).toBe(expected);
  });

  const held: ReadonlyArray<
    readonly [string, Parameters<typeof isLoopbackGatewayHeld>[0], boolean]
  > = [
    ["unknown, was forwarding", { state: "unknown", wasActive: true, disabledByUser: false }, true],
    [
      "unknown, never forwarded",
      { state: "unknown", wasActive: false, disabledByUser: false },
      false,
    ],
    [
      "unknown, user switched off",
      { state: "unknown", wasActive: true, disabledByUser: true },
      false,
    ],
    ["known", { state: "active", wasActive: true, disabledByUser: false }, false],
  ];
  it.each(held)("held: %s", (_name, input, expected) => {
    expect(isLoopbackGatewayHeld(input)).toBe(expected);
  });
});

describe("loopback gateway latch", () => {
  type Input = Parameters<typeof nextGateLatch>[1];
  const base: Input = {
    state: "active",
    connecting: true,
    registration: "registered",
    wasActive: false,
    disabledByUser: false,
    canOperate: true,
  };
  const rows: ReadonlyArray<readonly [string, GateLatch, Partial<Input>, GateLatch]> = [
    [
      "nothing forwarded, opens plain",
      "closed",
      { state: "unsupported-server", registration: undefined },
      "plain",
    ],
    [
      "the user's switch opens plain",
      "closed",
      { state: "disabled-by-user", registration: "stopped" },
      "plain",
    ],
    ["forwarded and registered opens forwarding", "closed", {}, "forwarding"],
    [
      "forwarded, not registered yet, stays closed",
      "closed",
      { registration: "pending" },
      "closed",
    ],
    // Only a webview that exists latches.
    [
      "cannot operate: no latch",
      "closed",
      { state: "unsupported-server", registration: undefined, canOperate: false },
      "closed",
    ],
    [
      "cannot operate, then forwarded and not registered",
      "closed",
      { registration: "pending" },
      "closed",
    ],
    ["cannot operate: a latch is let go", "forwarding", { canOperate: false }, "closed"],
    // A plain page cannot stay once forwarding starts.
    [
      "plain, then forwarded and not registered: closes",
      "plain",
      { registration: "pending" },
      "closed",
    ],
    [
      "plain, then forwarded, registration unknown: closes",
      "plain",
      { registration: undefined },
      "closed",
    ],
    [
      "plain, user resumes forwarding, proxy not installed: closes",
      "plain",
      { registration: "stopped" },
      "closed",
    ],
    ["plain, then forwarded and registered: reopens forwarded", "plain", {}, "forwarding"],
    [
      "plain stays through other states",
      "plain",
      { state: "unknown", registration: undefined, connecting: false },
      "plain",
    ],
    [
      "closed, then registered: opens forwarding",
      "closed",
      { registration: "registered" },
      "forwarding",
    ],
    // A forwarding page stays through a dropped connection and a failed registration.
    [
      "forwarding, connection drops",
      "forwarding",
      { state: "unknown", wasActive: true, connecting: false, registration: undefined },
      "forwarding",
    ],
    ["forwarding, registration fails", "forwarding", { registration: "failed" }, "forwarding"],
    ["forwarding, re-registering", "forwarding", { registration: "pending" }, "forwarding"],
  ];
  it.each(rows)("%s", (_name, latch, overrides, expected) => {
    expect(nextGateLatch(latch, { ...base, ...overrides })).toBe(expected);
  });
});
