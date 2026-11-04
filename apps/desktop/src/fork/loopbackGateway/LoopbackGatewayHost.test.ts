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
}

const fakeSession = (): FakeSession => {
  const fake: FakeSession = {
    session: undefined as unknown as Electron.Session,
    calls: [],
    proxyConfigs: [],
    headerListener: undefined,
    gate: undefined,
  };
  const session = {
    setProxy: async (config: Electron.ProxyConfig) => {
      await fake.gate;
      fake.calls.push(`setProxy:${config.mode}`);
      fake.proxyConfigs.push(config);
    },
    closeAllConnections: async () => {
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
    expect(session.calls).toEqual(["setProxy:fixed_servers", "headers:on"]);
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
    expect(host.answerProxyLogin({ ...proxyLogin, session: undefined })).toBeNull();
    expect(host.answerProxyLogin({ ...proxyLogin, session: stranger.session })).toBeNull();
    // Another environment's session against this environment's proxy, and the reverse.
    expect(host.answerProxyLogin({ ...proxyLogin, session: c.session })).toBeNull();
    expect(login(host, b.session, portC)).toBeNull();
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
