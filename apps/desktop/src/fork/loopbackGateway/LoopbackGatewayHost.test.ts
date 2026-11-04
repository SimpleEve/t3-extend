// @effect-diagnostics nodeBuiltinImport:off -- Real loopback sockets confirm which proxy a session was pointed at.
import * as NodeNet from "node:net";

import type {
  LoopbackGatewayCredential,
  LoopbackGatewayEvent,
} from "@t3tools/shared/forkLoopbackGateway/bridge";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import type * as Electron from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  makeLoopbackGatewayHost,
  makeProxyLoginListener,
  type LoopbackGatewayHost,
} from "./LoopbackGatewayHost.ts";
import { proxyAuthorization, requestViaProxy } from "./proxyClient.testkit.ts";

const LAN = "https://b.example.com:3873";
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const credential = (ticket = "ticket-body.signature"): LoopbackGatewayCredential => ({
  ticket: Redacted.make(ticket),
  expiresAt: DateTime.makeUnsafe(NOW + 5 * 60_000),
});

const hosts: Array<LoopbackGatewayHost> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) await host.dispose();
});

interface FakeSession {
  readonly session: Electron.Session;
  /** Every call that changes networking, in order. */
  readonly calls: Array<string>;
  readonly proxyConfigs: Array<Electron.ProxyConfig>;
  headerListener: unknown;
  gate: Promise<void> | undefined;
  /** Make the named call throw until cleared. */
  failing: Set<"setProxy" | "closeAllConnections">;
  /** Make the next this-many calls to `setProxy` throw. */
  failSetProxyTimes: number;
}

const fakeSession = (): FakeSession => {
  const fake: FakeSession = {
    session: undefined as unknown as Electron.Session,
    calls: [],
    proxyConfigs: [],
    headerListener: undefined,
    gate: undefined,
    failing: new Set(),
    failSetProxyTimes: 0,
  };
  const session = {
    setProxy: async (config: Electron.ProxyConfig) => {
      await fake.gate;
      if (fake.failing.has("setProxy") || fake.failSetProxyTimes > 0) {
        fake.failSetProxyTimes = Math.max(0, fake.failSetProxyTimes - 1);
        throw new Error("setProxy failed");
      }
      fake.calls.push(`setProxy:${config.mode}`);
      fake.proxyConfigs.push(config);
    },
    closeAllConnections: async () => {
      if (fake.failing.has("closeAllConnections")) throw new Error("closeAllConnections failed");
      fake.calls.push("closeAllConnections");
    },
    webRequest: {
      onHeadersReceived: (listener: unknown) => {
        fake.calls.push(listener === null ? "headers:off" : "headers:on");
        fake.headerListener = listener;
      },
    },
  } as unknown as Electron.Session;
  return Object.assign(fake, { session });
};

const makeHost = () => {
  const events: Array<LoopbackGatewayEvent> = [];
  const host = makeLoopbackGatewayHost({ emit: (event) => events.push(event) });
  hosts.push(host);
  return { host, events };
};

const portOf = (config: Electron.ProxyConfig | undefined): number => {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)$/u.exec(config?.proxyRules ?? "");
  if (match === null) throw new Error(`not a loopback proxy rule: ${config?.proxyRules}`);
  return Number(match[1]);
};

const login = (host: LoopbackGatewayHost, session: Electron.Session, port: number) =>
  host.answerProxyLogin({ isProxy: true, host: "127.0.0.1", port, session });

describe("pointing sessions at the proxy", () => {
  it("leaves a session of an environment nobody registered exactly as it was", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.installSession("env-b", session.session);
    expect(session.calls).toEqual([]);
  });

  it("uses the rule string of the design and an address nobody else can reach without the password", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.installSession("env-b", session.session);
    await host.register({
      environmentId: "env-b",
      httpBaseUrl: LAN,
      enabled: true,
      credential: credential(),
    });

    expect(session.proxyConfigs).toHaveLength(1);
    const config = session.proxyConfigs[0]!;
    expect(config).toEqual({
      mode: "fixed_servers",
      proxyRules: `http://127.0.0.1:${portOf(config)}`,
      proxyBypassRules: "*;<-loopback>",
    });
    expect(session.headerListener).toBeTypeOf("function");
    const unauthenticated = await requestViaProxy(
      portOf(config),
      undefined,
      "http://localhost:5173/",
    );
    expect(unauthenticated.status).toBe(407);
  });

  it("has the proxy set before installSession returns for a session created after registering", async () => {
    const { host } = makeHost();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    const session = fakeSession();
    const release = Promise.withResolvers<void>();
    session.gate = release.promise;

    let returned = false;
    const installing = host.installSession("env-b", session.session).then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    release.resolve();
    await installing;
    expect(session.calls).toEqual(["setProxy:fixed_servers", "headers:on", "closeAllConnections"]);
  });

  it("proxies sessions that were handed out before the environment registered", async () => {
    const { host } = makeHost();
    const first = fakeSession();
    const second = fakeSession();
    await host.installSession("env-b", first.session);
    await host.installSession("env-b", second.session);

    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });

    expect(portOf(first.proxyConfigs[0])).toBe(portOf(second.proxyConfigs[0]));
  });

  it("gives each environment its own proxy", async () => {
    const { host } = makeHost();
    const b = fakeSession();
    const c = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.register({
      environmentId: "env-c",
      httpBaseUrl: "https://c.example.com",
      enabled: true,
    });
    await host.installSession("env-b", b.session);
    await host.installSession("env-c", c.session);
    expect(portOf(b.proxyConfigs[0])).not.toBe(portOf(c.proxyConfigs[0]));
  });

  it("restores the session's networking and drops its connections when forwarding is turned off", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", session.session);
    session.calls.length = 0;

    await host.setEnabled("env-b", false);

    expect(session.calls).toEqual(["setProxy:system", "headers:off", "closeAllConnections"]);
    expect(session.proxyConfigs.at(-1)).toEqual({ mode: "system" });
    expect(session.headerListener).toBeNull();
  });

  it("points sessions at a new proxy when forwarding is turned back on", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", session.session);
    await host.setEnabled("env-b", false);
    await host.setEnabled("env-b", true);
    expect(session.proxyConfigs.map((config) => config.mode)).toEqual([
      "fixed_servers",
      "system",
      "fixed_servers",
    ]);
  });

  it("takes sessions off the proxy when the route stops being encrypted", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", session.session);

    const status = await host.register({
      environmentId: "env-b",
      httpBaseUrl: "http://192.168.1.5:3873",
      enabled: true,
    });

    expect(status.state).toBe("unsupported-route");
    expect(session.proxyConfigs.at(-1)).toEqual({ mode: "system" });
  });

  it("restores sessions and stops listening when the environment is unregistered", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", session.session);
    const port = portOf(session.proxyConfigs[0]);

    await host.unregister("env-b");

    expect(session.proxyConfigs.at(-1)).toEqual({ mode: "system" });
    expect(host.getStatus("env-b")).toBeNull();
    const refused = await new Promise<string | undefined>((resolve) => {
      const socket = NodeNet.connect(port, "127.0.0.1", () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code));
    });
    expect(refused).toBe("ECONNREFUSED");
  });

  it("restores every session on dispose", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", session.session);
    await host.dispose();
    expect(session.proxyConfigs.at(-1)).toEqual({ mode: "system" });
  });

  it("answers null for an environment that is not registered", async () => {
    const { host } = makeHost();
    expect(await host.updateTicket("nope", credential())).toBeNull();
    expect(await host.setEnabled("nope", false)).toBeNull();
    expect(await host.setReachable("nope", false)).toBeNull();
    expect(host.getStatus("nope")).toBeNull();
  });
});

describe("connections made before the proxy was set", () => {
  it("are dropped when a session first moves from system networking to the proxy", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.installSession("env-b", session.session);
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    expect(session.calls).toEqual(["setProxy:fixed_servers", "headers:on", "closeAllConnections"]);
  });

  it("are dropped for a session that was already open when the environment registered", async () => {
    const { host } = makeHost();
    const open = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", open.session);
    expect(open.calls.at(-1)).toBe("closeAllConnections");
    expect(open.calls.indexOf("closeAllConnections")).toBeGreaterThan(
      open.calls.indexOf("setProxy:fixed_servers"),
    );
  });
});

describe("sessions that fail to switch", () => {
  const threeSessions = async () => {
    const { host, events } = makeHost();
    const [a, b, c] = [fakeSession(), fakeSession(), fakeSession()] as const;
    for (const fake of [a, b, c]) await host.installSession("env-b", fake.session);
    return { host, events, a, b, c };
  };
  const lastMode = (fake: FakeSession) => fake.proxyConfigs.at(-1)?.mode;

  it("reports the environment as failed, still switches the others, and converges on the next operation", async () => {
    const { host, a, b, c } = await threeSessions();
    b.failing.add("setProxy");

    const status = await host.register({
      environmentId: "env-b",
      httpBaseUrl: LAN,
      enabled: true,
      credential: credential(),
    });

    expect(status).toEqual({ state: "rejected", code: "internal" });
    expect(host.getStatus("env-b")).toEqual({ state: "rejected", code: "internal" });
    expect([lastMode(a), lastMode(b), lastMode(c)]).toEqual([
      "fixed_servers",
      undefined,
      "fixed_servers",
    ]);

    b.failing.clear();
    expect(await host.updateTicket("env-b", credential("renewed.ticket"))).toEqual({
      state: "active",
    });
    expect([lastMode(a), lastMode(b), lastMode(c)]).toEqual([
      "fixed_servers",
      "fixed_servers",
      "fixed_servers",
    ]);
    // The sessions that were already switched are not switched again.
    expect([a.proxyConfigs.length, c.proxyConfigs.length]).toEqual([1, 1]);
    expect(b.proxyConfigs[0]).toEqual(a.proxyConfigs[0]);
  });

  it("keeps trying the failed session until it works, whatever the operation", async () => {
    const { host, b } = await threeSessions();
    b.failing.add("setProxy");
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    expect(await host.setReachable("env-b", true)).toEqual({ state: "rejected", code: "internal" });
    b.failing.clear();
    await host.setReachable("env-b", true);
    expect(lastMode(b)).toBe("fixed_servers");
    expect(host.getStatus("env-b")?.state).toBe("pending");
  });

  it("does not forget a session that is still on the proxy when restoring it failed", async () => {
    const { host, a, b, c } = await threeSessions();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    const port = host.getStatus("env-b") && portOf(a.proxyConfigs[0]);
    b.failing.add("setProxy");

    const status = await host.setEnabled("env-b", false);

    expect(status).toEqual({ state: "rejected", code: "internal" });
    expect([lastMode(a), lastMode(b), lastMode(c)]).toEqual(["system", "fixed_servers", "system"]);
    // Aimed at a proxy that is gone, so its loopback requests fail instead of going anywhere.
    const refused = await new Promise<string | undefined>((resolve) => {
      const socket = NodeNet.connect(port!, "127.0.0.1", () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code));
    });
    expect(refused).toBe("ECONNREFUSED");

    b.failing.clear();
    expect(await host.setReachable("env-b", true)).toEqual({ state: "disabled-by-user" });
    expect(lastMode(b)).toBe("system");
    expect(b.calls.slice(-3)).toEqual(["setProxy:system", "headers:off", "closeAllConnections"]);
  });

  it("retries a restore whose later steps failed after the proxy setting changed", async () => {
    const { host, b } = await threeSessions();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    b.failing.add("closeAllConnections");
    expect(await host.setEnabled("env-b", false)).toEqual({ state: "rejected", code: "internal" });
    b.failing.clear();
    expect(await host.setEnabled("env-b", false)).toEqual({ state: "disabled-by-user" });
    expect(b.calls.slice(-3)).toEqual(["setProxy:system", "headers:off", "closeAllConnections"]);
  });

  it("fails installSession for the session that cannot be switched and lets a retry succeed", async () => {
    const { host } = makeHost();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    const good = fakeSession();
    const bad = fakeSession();
    await host.installSession("env-b", good.session);
    bad.failing.add("setProxy");

    await expect(host.installSession("env-b", bad.session)).rejects.toThrow();
    expect(host.getStatus("env-b")).toEqual({ state: "rejected", code: "internal" });
    expect(lastMode(good)).toBe("fixed_servers");

    bad.failing.clear();
    await host.installSession("env-b", bad.session);
    expect(lastMode(bad)).toBe("fixed_servers");
    expect(host.getStatus("env-b")?.state).toBe("pending");
  });

  it("fails installSession when connections cannot be dropped, and finishes the job on retry", async () => {
    const { host } = makeHost();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    const session = fakeSession();
    session.failing.add("closeAllConnections");
    await expect(host.installSession("env-b", session.session)).rejects.toThrow();
    session.failing.clear();
    await host.installSession("env-b", session.session);
    expect(session.calls.at(-1)).toBe("closeAllConnections");
  });
});

describe("unregistering an environment whose sessions cannot be restored", () => {
  const registered = async () => {
    const { host } = makeHost();
    const a = fakeSession();
    const b = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", a.session);
    await host.installSession("env-b", b.session);
    return { host, a, b, port: portOf(a.proxyConfigs[0]) };
  };
  const stillAimedAt = (fake: FakeSession) => fake.proxyConfigs.at(-1)?.mode === "fixed_servers";
  const refused = (port: number) =>
    new Promise<string | undefined>((resolve) => {
      const socket = NodeNet.connect(port, "127.0.0.1", () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code));
    });

  it.each(["setProxy", "closeAllConnections"] as const)(
    "recovers through installSession after %s failed",
    async (step) => {
      const { host, a, b, port } = await registered();
      b.failing.add(step);

      await expect(host.unregister("env-b")).rejects.toThrow();
      expect(host.getStatus("env-b")).toBeNull();
      // Nothing is listening any more, so a session left behind fails its requests.
      expect(await refused(port)).toBe("ECONNREFUSED");

      // The environment is gone, yet the session still has to come back before a webview attaches.
      await expect(host.installSession("env-b", b.session)).rejects.toThrow();
      b.failing.clear();
      await host.installSession("env-b", b.session);

      expect(a.proxyConfigs.at(-1)).toEqual({ mode: "system" });
      expect(b.proxyConfigs.at(-1)).toEqual({ mode: "system" });
      expect(b.calls.at(-1)).toBe("closeAllConnections");
    },
  );

  it.each(["setProxy", "closeAllConnections"] as const)(
    "recovers through a second unregister after %s failed",
    async (step) => {
      const { host, b } = await registered();
      b.failing.add(step);
      await expect(host.unregister("env-b")).rejects.toThrow();
      await expect(host.unregister("env-b")).rejects.toThrow();

      b.failing.clear();
      await host.unregister("env-b");

      expect(b.proxyConfigs.at(-1)).toEqual({ mode: "system" });
      expect(b.calls.slice(-3)).toEqual(["setProxy:system", "headers:off", "closeAllConnections"]);
      // Nothing is left to do the next time.
      const calls = b.calls.length;
      await host.unregister("env-b");
      expect(b.calls).toHaveLength(calls);
    },
  );

  it("leaves no session on the closed proxy once a retry has succeeded", async () => {
    const { host, a, b } = await registered();
    a.failing.add("setProxy");
    await expect(host.unregister("env-b")).rejects.toThrow();
    expect([stillAimedAt(a), stillAimedAt(b)]).toEqual([true, false]);
    a.failing.clear();
    await host.unregister("env-b");
    expect([stillAimedAt(a), stillAimedAt(b)]).toEqual([false, false]);
  });

  it("does not touch a session of an environment that was never registered", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.unregister("env-never");
    await host.installSession("env-never", session.session);
    expect(session.calls).toEqual([]);
  });
});

describe("operations on one environment id", () => {
  it("run one after another: a register that arrives during an unregister waits for it", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", session.session);
    const oldPort = portOf(session.proxyConfigs[0]);

    // The restore of the old environment stops half way, at setProxy.
    const release = Promise.withResolvers<void>();
    session.gate = release.promise;
    const unregistering = host.unregister("env-b");
    const registering = host.register({
      environmentId: "env-b",
      httpBaseUrl: "https://c.example.com",
      enabled: true,
    });
    await Promise.resolve();
    release.resolve();
    await Promise.all([unregistering, registering]);

    // The session ends on the new environment's proxy, and the host agrees.
    const config = session.proxyConfigs.at(-1)!;
    expect(config.mode).toBe("fixed_servers");
    expect(portOf(config)).not.toBe(oldPort);
    expect(host.getStatus("env-b")?.state).toBe("pending");
    expect(
      host.answerProxyLogin({
        isProxy: true,
        host: "127.0.0.1",
        port: portOf(config),
        session: session.session,
      }),
    ).not.toBeNull();
    expect(
      host.answerProxyLogin({
        isProxy: true,
        host: "127.0.0.1",
        port: oldPort,
        session: undefined,
      }),
    ).toBeNull();
  });

  it("run in the order they were called, whichever of them was started first", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.installSession("env-b", session.session);
    const release = Promise.withResolvers<void>();
    session.gate = release.promise;

    const order: Array<string> = [];
    const register = host
      .register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true })
      .then(() => order.push("register"));
    const disable = host.setEnabled("env-b", false).then(() => order.push("disable"));
    const enable = host.setEnabled("env-b", true).then(() => order.push("enable"));
    await Promise.resolve();
    release.resolve();
    await Promise.all([register, disable, enable]);

    expect(order).toEqual(["register", "disable", "enable"]);
    expect(host.getStatus("env-b")?.state).toBe("pending");
    expect(session.proxyConfigs.at(-1)?.mode).toBe("fixed_servers");
  });

  it("go on after one of them failed", async () => {
    const { host } = makeHost();
    const session = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", session.session);
    // The environment's own restore and the host's retry of it both fail; the register after them must not.
    session.failSetProxyTimes = 2;
    const failing = host.unregister("env-b");
    const later = host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await expect(failing).rejects.toThrow();
    expect((await later).state).toBe("pending");
    expect(session.proxyConfigs.at(-1)?.mode).toBe("fixed_servers");
  });

  it("do not wait for operations on another environment id", async () => {
    const { host } = makeHost();
    const slow = fakeSession();
    await host.installSession("env-slow", slow.session);
    const release = Promise.withResolvers<void>();
    slow.gate = release.promise;

    const blocked = host.register({ environmentId: "env-slow", httpBaseUrl: LAN, enabled: true });
    const other = fakeSession();
    await host.installSession("env-other", other.session);
    const status = await host.register({
      environmentId: "env-other",
      httpBaseUrl: "https://c.example.com",
      enabled: true,
    });
    expect(status.state).toBe("pending");
    expect(other.proxyConfigs.at(-1)?.mode).toBe("fixed_servers");
    expect(slow.proxyConfigs).toEqual([]);

    release.resolve();
    await blocked;
    expect(slow.proxyConfigs.at(-1)?.mode).toBe("fixed_servers");
  });
});

describe("answering the proxy's password challenge", () => {
  const setup = async () => {
    const { host, events } = makeHost();
    const b = fakeSession();
    const c = fakeSession();
    const stranger = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.register({
      environmentId: "env-c",
      httpBaseUrl: "https://c.example.com",
      enabled: true,
    });
    await host.installSession("env-b", b.session);
    await host.installSession("env-c", c.session);
    return {
      host,
      events,
      b,
      c,
      stranger,
      portB: portOf(b.proxyConfigs[0]),
      portC: portOf(c.proxyConfigs[0]),
    };
  };

  it("answers the right proxy, from the right session, with a password that works", async () => {
    const { host, b, portB } = await setup();
    const answer = login(host, b.session, portB);
    expect(answer).not.toBeNull();
    const response = await requestViaProxy(
      portB,
      proxyAuthorization(answer!.username, answer!.password),
      "http://localhost:5173/",
    );
    expect(response.status).not.toBe(407);
  });

  it("does not answer for a different host, port, kind of challenge or session", async () => {
    const { host, b, c, stranger, portB, portC } = await setup();
    const proxyLogin = { isProxy: true, host: "127.0.0.1", port: portB, session: b.session };
    expect(host.answerProxyLogin({ ...proxyLogin, host: "localhost" })).toBeNull();
    expect(host.answerProxyLogin({ ...proxyLogin, host: "::1" })).toBeNull();
    expect(host.answerProxyLogin({ ...proxyLogin, host: "127.0.0.2" })).toBeNull();
    expect(host.answerProxyLogin({ ...proxyLogin, host: "proxy.corp.example" })).toBeNull();
    expect(host.answerProxyLogin({ ...proxyLogin, port: portB + 1 })).toBeNull();
    expect(host.answerProxyLogin({ ...proxyLogin, isProxy: false })).toBeNull();
    expect(host.answerProxyLogin({ ...proxyLogin, session: stranger.session })).toBeNull();
    // Another environment's session against this environment's proxy, and the reverse.
    expect(host.answerProxyLogin({ ...proxyLogin, session: c.session })).toBeNull();
    expect(login(host, b.session, portC)).toBeNull();
  });

  it("answers a request that has no webContents when the port is a registered proxy's", async () => {
    const { host, portB, portC } = await setup();
    const forB = host.answerProxyLogin({
      isProxy: true,
      host: "127.0.0.1",
      port: portB,
      session: undefined,
    });
    const forC = host.answerProxyLogin({
      isProxy: true,
      host: "127.0.0.1",
      port: portC,
      session: undefined,
    });
    expect(forB).not.toBeNull();
    expect(forC).not.toBeNull();
    expect(forB!.password).not.toBe(forC!.password);
    const okB = await requestViaProxy(
      portB,
      proxyAuthorization(forB!.username, forB!.password),
      "http://localhost:5173/",
    );
    const wrongB = await requestViaProxy(
      portB,
      proxyAuthorization(forC!.username, forC!.password),
      "http://localhost:5173/",
    );
    expect(okB.status).not.toBe(407);
    expect(wrongB.status).toBe(407);
  });

  it("does not answer a request without webContents for another port, host or kind of challenge", async () => {
    const { host, portB } = await setup();
    const bare = { isProxy: true, host: "127.0.0.1", port: portB, session: undefined };
    expect(host.answerProxyLogin({ ...bare, port: 1 })).toBeNull();
    expect(host.answerProxyLogin({ ...bare, port: 80 })).toBeNull();
    expect(host.answerProxyLogin({ ...bare, host: "localhost" })).toBeNull();
    expect(host.answerProxyLogin({ ...bare, host: "::1" })).toBeNull();
    expect(host.answerProxyLogin({ ...bare, host: "proxy.corp.example" })).toBeNull();
    expect(host.answerProxyLogin({ ...bare, isProxy: false })).toBeNull();
  });

  it("does not answer a request without webContents once the proxy is gone", async () => {
    const { host, portB } = await setup();
    await host.setEnabled("env-b", false);
    expect(
      host.answerProxyLogin({ isProxy: true, host: "127.0.0.1", port: portB, session: undefined }),
    ).toBeNull();
    await host.unregister("env-c");
  });

  it("does not answer once forwarding is off for the environment", async () => {
    const { host, b, portB } = await setup();
    await host.setEnabled("env-b", false);
    expect(login(host, b.session, portB)).toBeNull();
  });

  it("leaves the event alone unless it answers, and coexists with another listener", async () => {
    const { host, b, stranger, portB } = await setup();
    const listener = makeProxyLoginListener(host);

    // A stand-in for a listener that handles page authentication.
    const upstreamAnswers: Array<string> = [];
    const upstream = (
      isProxy: boolean,
      callback: (username?: string, password?: string) => void,
      prevented: () => boolean,
    ) => {
      if (!isProxy && !prevented()) {
        upstreamAnswers.push("page");
        callback("page-user", "page-password");
      }
    };

    const run = (
      webContents: { session: Electron.Session } | undefined,
      authInfo: { isProxy: boolean; host: string; port: number },
    ) => {
      let prevented = false;
      const answers: Array<[string | undefined, string | undefined]> = [];
      const callback = (username?: string, password?: string) => {
        answers.push([username, password]);
      };
      const event = { preventDefault: () => (prevented = true) };
      listener(event, webContents, authInfo, callback);
      upstream(authInfo.isProxy, callback, () => prevented);
      return { prevented, answers };
    };

    const ours = run({ session: b.session }, { isProxy: true, host: "127.0.0.1", port: portB });
    expect(ours.prevented).toBe(true);
    expect(ours.answers).toHaveLength(1);
    expect(ours.answers[0]![0]).toBe("t3x");

    const page = run({ session: b.session }, { isProxy: false, host: "127.0.0.1", port: portB });
    expect(page.prevented).toBe(false);
    expect(page.answers).toEqual([["page-user", "page-password"]]);

    const withoutWebContents = run(undefined, { isProxy: true, host: "127.0.0.1", port: portB });
    expect(withoutWebContents.prevented).toBe(true);
    expect(withoutWebContents.answers[0]![0]).toBe("t3x");
    const wrongPort = run(undefined, { isProxy: true, host: "127.0.0.1", port: 1 });
    expect(wrongPort.prevented).toBe(false);
    expect(wrongPort.answers).toEqual([]);

    const foreign = run(
      { session: stranger.session },
      { isProxy: true, host: "127.0.0.1", port: portB },
    );
    expect(foreign.prevented).toBe(false);
    expect(foreign.answers).toEqual([]);
  });

  it("keeps the password out of every event the host emits", async () => {
    const { host, events, b, portB } = await setup();
    const answer = login(host, b.session, portB)!;
    await host.setEnabled("env-b", false);
    await host.setEnabled("env-b", true);
    expect(JSON.stringify(events)).not.toContain(answer.password);
  });
});

describe("refused navigations", () => {
  const listenerFor = async () => {
    const { host, events } = makeHost();
    const session = fakeSession();
    await host.register({ environmentId: "env-b", httpBaseUrl: LAN, enabled: true });
    await host.installSession("env-b", session.session);
    events.length = 0;
    const listener = session.headerListener as (
      details: Partial<Electron.OnHeadersReceivedListenerDetails>,
      callback: (response: Electron.HeadersReceivedResponse) => void,
    ) => void;
    const respond = (details: Partial<Electron.OnHeadersReceivedListenerDetails>) => {
      let answered = 0;
      listener(details, () => {
        answered += 1;
      });
      return answered;
    };
    return { events, respond };
  };

  it("tells the renderer about a refused top-level navigation, with the webview and the URL", async () => {
    const { events, respond } = await listenerFor();
    const answered = respond({
      resourceType: "mainFrame",
      url: "http://localhost:5173/app",
      webContentsId: 42,
      responseHeaders: { "X-T3x-Gateway-Error": ["not-owned"] },
    });
    expect(answered).toBe(1);
    expect(events).toEqual([
      {
        type: "denied",
        environmentId: "env-b",
        code: "not-owned",
        port: 5173,
        mainFrame: true,
        url: "http://localhost:5173/app",
        webContentsId: 42,
      },
    ]);
  });

  it("reads the header whatever its case", async () => {
    const { events, respond } = await listenerFor();
    respond({
      resourceType: "mainFrame",
      url: "http://127.0.0.1:3000/",
      responseHeaders: { "x-t3x-gateway-error": ["upstream-refused"] },
    });
    expect(events).toHaveLength(1);
  });

  it.each([
    ["a subresource", { resourceType: "image", url: "http://localhost:5173/a.png" }],
    [
      "a code that is not one of ours",
      { resourceType: "mainFrame", url: "http://localhost:5173/", header: "<script>" },
    ],
    ["a page that is not loopback", { resourceType: "mainFrame", url: "https://evil.example/" }],
    ["a URL that is not a URL", { resourceType: "mainFrame", url: "nope" }],
  ])("ignores %s, and still lets the response through", async (_name, input) => {
    const { events, respond } = await listenerFor();
    const answered = respond({
      resourceType: input.resourceType as Electron.OnHeadersReceivedListenerDetails["resourceType"],
      url: input.url,
      responseHeaders: {
        "X-T3x-Gateway-Error": [("header" in input ? input.header : "not-owned") as string],
      },
    });
    expect(answered).toBe(1);
    expect(events).toEqual([]);
  });
});
