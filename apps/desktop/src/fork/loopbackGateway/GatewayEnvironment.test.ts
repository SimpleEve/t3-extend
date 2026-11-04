// @effect-diagnostics nodeBuiltinImport:off -- Socket-level tests against real loopback servers.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

import type {
  LoopbackGatewayCredential,
  LoopbackGatewayEvent,
} from "@t3tools/shared/forkLoopbackGateway/bridge";
import type { LoopbackGatewayErrorCode } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  GatewayInvalidTicketError,
  makeGatewayEnvironment,
  type GatewayEnvironment,
} from "./GatewayEnvironment.ts";
import { proxyAuthorization, requestViaProxy } from "./proxyClient.testkit.ts";
import { GatewayTunnelError } from "./tunnelErrors.ts";

const TICKET = "ticket-body.signature";
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const LAN = "https://b.example.com:3873";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const credential = (ticket = TICKET, lifetimeMs = 5 * 60_000): LoopbackGatewayCredential => ({
  ticket: Redacted.make(ticket),
  expiresAt: DateTime.makeUnsafe(NOW + lifetimeMs),
});

interface Rig {
  readonly environment: GatewayEnvironment;
  readonly events: Array<LoopbackGatewayEvent>;
  readonly proxyChanges: Array<number | null>;
  readonly opened: Array<{ baseUrl: string; ticket: string; port: number }>;
  readonly scheduled: Array<{ milliseconds: number; run: () => void; cancelled: boolean }>;
  readonly tunnels: Array<NodeStream.Duplex>;
  failWith: GatewayTunnelError | undefined;
  now: number;
}

const startRig = async (): Promise<Rig> => {
  // Tunnels are plain connections to a local HTTP service, so requests through the proxy complete.
  const service = NodeHttp.createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const servicePort = (service.address() as NodeNet.AddressInfo).port;
  cleanups.push(() => {
    service.closeAllConnections();
    return new Promise<void>((resolve) => service.close(() => resolve()));
  });
  const rig: Rig = {
    environment: undefined as unknown as GatewayEnvironment,
    events: [],
    proxyChanges: [],
    opened: [],
    scheduled: [],
    tunnels: [],
    failWith: undefined,
    now: NOW,
  };
  const environment = makeGatewayEnvironment({
    environmentId: "env-b",
    emit: (event) => rig.events.push(event),
    onProxyChange: async (proxy) => {
      rig.proxyChanges.push(proxy?.port ?? null);
    },
    openTunnel: async (input) => {
      rig.opened.push({
        baseUrl: input.baseUrl,
        ticket: Redacted.value(input.ticket),
        port: input.port,
      });
      if (rig.failWith !== undefined) throw rig.failWith;
      const tunnel = NodeNet.connect({ host: "127.0.0.1", port: servicePort });
      await new Promise<void>((resolve, reject) => {
        tunnel.once("connect", resolve);
        tunnel.once("error", reject);
      });
      rig.tunnels.push(tunnel);
      return tunnel;
    },
    now: () => rig.now,
    schedule: (run, milliseconds) => {
      const entry = { milliseconds, run, cancelled: false };
      rig.scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  cleanups.push(() => environment.close());
  return Object.assign(rig, { environment });
};

const get = (rig: Rig, target = "http://localhost:5173/") => {
  const credentials = rig.environment.proxyCredentials();
  if (credentials === null) throw new Error("no proxy");
  return requestViaProxy(
    credentials.port,
    proxyAuthorization(credentials.username, credentials.password),
    target,
  );
};

const statusEvents = (rig: Rig) =>
  rig.events.flatMap((event) => (event.type === "status" ? [event.status] : []));

describe("routing", () => {
  it.each([
    ["a plain LAN address", "http://192.168.1.5:3873", "insecure-transport", undefined],
    [
      "a plain Tailscale IPv4 address",
      "http://100.101.102.103:3873",
      "insecure-transport",
      "tailscale-address",
    ],
    ["something that is not a URL", "not a url", "unsupported-route", undefined],
  ] as const)("starts no proxy for %s", async (_name, httpBaseUrl, code, hint) => {
    const rig = await startRig();
    const status = await rig.environment.register({
      httpBaseUrl,
      enabled: true,
      credential: credential(),
    });
    expect(status).toEqual({
      state: "unsupported-route",
      code,
      ...(hint === undefined ? {} : { hint }),
    });
    expect(rig.proxyChanges).toEqual([]);
    expect(rig.environment.proxyPort()).toBeNull();
    expect(rig.environment.proxyCredentials()).toBeNull();
  });

  it.each([
    ["https", "https://b.example.com"],
    ["a local forwarded port", "http://127.0.0.1:4555"],
    ["a MagicDNS name", "http://mac.tail1234.ts.net:3873"],
  ])("starts a proxy for %s", async (_name, httpBaseUrl) => {
    const rig = await startRig();
    const status = await rig.environment.register({
      httpBaseUrl,
      enabled: true,
      credential: credential(),
    });
    expect(status).toEqual({ state: "active" });
    expect(rig.proxyChanges).toEqual([rig.environment.proxyPort()]);
  });

  it("answers requests with 503 and asks for a ticket while there is none", async () => {
    const rig = await startRig();
    expect(await rig.environment.register({ httpBaseUrl: LAN, enabled: true })).toEqual({
      state: "pending",
    });
    expect(rig.events).toContainEqual({ type: "ticket-needed", environmentId: "env-b" });

    const response = await get(rig);
    expect(response.status).toBe(503);
    expect(response.headers["x-t3x-gateway-error"]).toBe("unauthorized");
    expect(rig.opened).toEqual([]);

    expect(await rig.environment.updateTicket(credential())).toEqual({ state: "active" });
    expect((await get(rig)).status).toBe(200);
    expect(rig.opened).toEqual([{ baseUrl: LAN, ticket: TICKET, port: 5173 }]);
  });

  it("opens tunnels to the base URL and ticket it was given and no other", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    await get(rig, "http://localhost:3000/");
    await get(rig, "http://127.0.0.1:4000/");
    expect(rig.opened).toEqual([
      { baseUrl: LAN, ticket: TICKET, port: 3000 },
      { baseUrl: LAN, ticket: TICKET, port: 4000 },
    ]);
  });

  it("drops the ticket and open tunnels when the route changes, and wants a new ticket", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    await get(rig);
    const tunnel = rig.tunnels[0]!;
    const destroyed = new Promise<void>((resolve) => tunnel.once("close", () => resolve()));
    rig.events.length = 0;

    const status = await rig.environment.register({
      httpBaseUrl: "https://c.example.com",
      enabled: true,
    });

    await destroyed;
    expect(status).toEqual({ state: "pending" });
    expect(rig.events).toContainEqual({ type: "ticket-needed", environmentId: "env-b" });
    expect((await get(rig)).status).toBe(503);
    expect(rig.opened).toHaveLength(1);

    await rig.environment.updateTicket(credential("second.ticket"));
    await get(rig);
    expect(rig.opened[1]).toEqual({
      baseUrl: "https://c.example.com",
      ticket: "second.ticket",
      port: 5173,
    });
  });

  it("keeps the ticket when the same route is registered again", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    const port = rig.environment.proxyPort();
    expect(await rig.environment.register({ httpBaseUrl: LAN, enabled: true })).toEqual({
      state: "active",
    });
    expect(rig.environment.proxyPort()).toBe(port);
    expect(rig.proxyChanges).toEqual([port]);
  });

  it("stops the proxy and closes tunnels when the route stops passing the transport check", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    await get(rig);
    const tunnel = rig.tunnels[0]!;
    const destroyed = new Promise<void>((resolve) => tunnel.once("close", () => resolve()));

    const status = await rig.environment.register({
      httpBaseUrl: "http://192.168.1.5:3873",
      enabled: true,
      credential: credential(),
    });

    await destroyed;
    expect(status).toEqual({ state: "unsupported-route", code: "insecure-transport" });
    expect(rig.proxyChanges.at(-1)).toBeNull();
    expect(rig.environment.proxyCredentials()).toBeNull();
  });
});

describe("turning forwarding off and on", () => {
  it("stops the proxy and closes tunnels, and starts a fresh proxy on resume", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    const first = rig.environment.proxyCredentials()!;
    await get(rig);
    const destroyed = new Promise<void>((resolve) =>
      rig.tunnels[0]!.once("close", () => resolve()),
    );

    expect(await rig.environment.setEnabled(false)).toEqual({ state: "disabled-by-user" });
    await destroyed;
    expect(rig.proxyChanges.at(-1)).toBeNull();
    const refused = await new Promise<string | undefined>((resolve) => {
      const socket = NodeNet.connect(first.port, "127.0.0.1", () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code));
    });
    expect(refused).toBe("ECONNREFUSED");

    expect(await rig.environment.setEnabled(true)).toEqual({ state: "active" });
    const second = rig.environment.proxyCredentials()!;
    expect(second.password).not.toBe(first.password);
  });

  it("registers as disabled-by-user without ever starting a proxy", async () => {
    const rig = await startRig();
    expect(
      await rig.environment.register({
        httpBaseUrl: LAN,
        enabled: false,
        credential: credential(),
      }),
    ).toEqual({ state: "disabled-by-user" });
    expect(rig.proxyChanges).toEqual([]);
  });

  it("reports the environment offline while the renderer says it is, and recovers", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    expect(await rig.environment.setReachable(false)).toEqual({ state: "offline" });
    const response = await get(rig);
    expect(response.status).toBe(502);
    expect(response.headers["x-t3x-gateway-error"]).toBe("offline");
    expect(rig.opened).toEqual([]);
    expect(await rig.environment.setReachable(true)).toEqual({ state: "active" });
  });
});

describe("what a failed tunnel says about the environment", () => {
  it.each([
    ["unauthorized", { state: "rejected", code: "unauthorized" }],
    ["forbidden", { state: "rejected", code: "forbidden" }],
    ["tls-untrusted", { state: "rejected", code: "tls-untrusted" }],
    ["unexpected-redirect", { state: "rejected", code: "unexpected-redirect" }],
    ["unsupported-server", { state: "rejected", code: "unsupported-server" }],
    ["offline", { state: "offline", code: "offline" }],
  ] as const)("%s changes the status", async (code, expected) => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    rig.failWith = new GatewayTunnelError(code);
    await get(rig);
    expect(rig.environment.status()).toEqual(expected);
    expect(statusEvents(rig).at(-1)).toEqual(expected);
  });

  it.each([
    "not-owned",
    "reserved",
    "debug-process",
    "upstream-refused",
    "owner-changed",
    "limit-reached",
  ] as const)("%s is about one port and leaves the status alone", async (code) => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    rig.failWith = new GatewayTunnelError(code);
    const response = await get(rig);
    expect(response.headers["x-t3x-gateway-error"]).toBe(code);
    expect(rig.environment.status()).toEqual({ state: "active" });
  });

  it("asks for a new ticket on unauthorized and recovers when it arrives", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    rig.events.length = 0;
    rig.failWith = new GatewayTunnelError("unauthorized");
    await get(rig);
    expect(rig.events).toContainEqual({ type: "ticket-needed", environmentId: "env-b" });

    rig.failWith = undefined;
    expect(await rig.environment.updateTicket(credential("renewed.ticket"))).toEqual({
      state: "active",
    });
  });

  it("goes back to active when a tunnel opens after a failure", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    rig.failWith = new GatewayTunnelError("offline");
    await get(rig);
    expect(rig.environment.status().state).toBe("offline");
    rig.failWith = undefined;
    await get(rig);
    expect(rig.environment.status()).toEqual({ state: "active" });
  });

  it("tells the renderer about a refused CONNECT, which has no page to show it on", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    rig.failWith = new GatewayTunnelError("not-owned");
    const { port, username, password } = rig.environment.proxyCredentials()!;
    const socket = NodeNet.connect(port, "127.0.0.1", () =>
      socket.write(
        `CONNECT localhost:5173 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${proxyAuthorization(username, password)}\r\n\r\n`,
      ),
    );
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    socket.destroy();
    expect(rig.events).toContainEqual({
      type: "denied",
      environmentId: "env-b",
      code: "not-owned" satisfies LoopbackGatewayErrorCode,
      port: 5173,
      mainFrame: false,
    });
  });
});

describe("ticket renewal", () => {
  it("asks for a new ticket 60 seconds before the old one expires, once", async () => {
    const rig = await startRig();
    await rig.environment.register({
      httpBaseUrl: LAN,
      enabled: true,
      credential: credential(TICKET, 5 * 60_000),
    });
    expect(rig.scheduled.map((entry) => entry.milliseconds)).toEqual([4 * 60_000]);
    rig.events.length = 0;
    rig.now += 4 * 60_000;
    rig.scheduled[0]!.run();
    expect(rig.events).toEqual([{ type: "ticket-needed", environmentId: "env-b" }]);
  });

  it("never schedules a timer longer than a timer can be, and checks again when it fires", async () => {
    const rig = await startRig();
    const thirtyDays = 30 * 24 * 60 * 60_000;
    await rig.environment.register({
      httpBaseUrl: LAN,
      enabled: true,
      credential: credential(TICKET, thirtyDays),
    });
    expect(rig.scheduled).toHaveLength(1);
    expect(rig.scheduled[0]!.milliseconds).toBe(2 ** 31 - 1);
    rig.events.length = 0;
    rig.now += 2 ** 31 - 1;
    rig.scheduled[0]!.run();
    expect(rig.events).toEqual([]);
    expect(rig.scheduled).toHaveLength(2);
    expect(rig.scheduled[1]!.milliseconds).toBe(thirtyDays - (2 ** 31 - 1) - 60_000);
  });

  it("cancels the reminder when a newer ticket arrives", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true, credential: credential() });
    await rig.environment.updateTicket(credential("newer.ticket", 10 * 60_000));
    expect(rig.scheduled.map((entry) => [entry.milliseconds, entry.cancelled])).toEqual([
      [4 * 60_000, true],
      [9 * 60_000, false],
    ]);
  });

  it("asks at once for a ticket that is nearly expired, but not in a loop", async () => {
    const rig = await startRig();
    await rig.environment.register({
      httpBaseUrl: LAN,
      enabled: true,
      credential: credential(TICKET, 30_000),
    });
    expect(rig.events.filter((event) => event.type === "ticket-needed")).toHaveLength(1);
    await rig.environment.updateTicket(credential("also.short", 30_000));
    expect(rig.events.filter((event) => event.type === "ticket-needed")).toHaveLength(1);
    rig.now += 2_000;
    await rig.environment.updateTicket(credential("still.short", 30_000));
    expect(rig.events.filter((event) => event.type === "ticket-needed")).toHaveLength(2);
  });
});

describe("what the ticket and the password may touch", () => {
  it("refuses a ticket of the wrong shape without echoing it", async () => {
    const rig = await startRig();
    await rig.environment.register({ httpBaseUrl: LAN, enabled: true });
    const bad = "sentinel ticket with spaces";
    const error = await rig.environment.updateTicket(credential(bad)).then(
      () => undefined,
      (caught: Error) => caught,
    );
    expect(error).toBeInstanceOf(GatewayInvalidTicketError);
    expect(`${error!.message}${error!.stack}`).not.toContain("sentinel");
    expect(await rig.environment.register({ httpBaseUrl: LAN, enabled: true })).toEqual({
      state: "pending",
    });
  });

  it("never puts the ticket or the proxy password into an event or a status", async () => {
    const rig = await startRig();
    const sentinel = "sentinel-ticket-0123456789.abcdef";
    await rig.environment.register({
      httpBaseUrl: LAN,
      enabled: true,
      credential: credential(sentinel),
    });
    const password = rig.environment.proxyCredentials()!.password;
    for (const code of ["unauthorized", "forbidden", "tls-untrusted", "offline"] as const) {
      rig.failWith = new GatewayTunnelError(code);
      await get(rig);
    }
    await rig.environment.setEnabled(false);
    await rig.environment.setEnabled(true);
    await rig.environment.register({ httpBaseUrl: "https://c.example.com", enabled: true });

    const everything = JSON.stringify({ events: rig.events, status: rig.environment.status() });
    expect(everything).not.toContain(sentinel);
    expect(everything).not.toContain(password);
    expect(everything).not.toContain(sentinel.slice(0, 12));
  });
});
