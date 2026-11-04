// fork: the body of the real-Electron gateway smoke, started by run.mjs.
// A fixture that answered while the fake gateway saw no tunnel for its port went direct: a leak.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { app, BrowserWindow, session as electronSession } from "electron";
import type { Session } from "electron";
import { WebSocketServer } from "ws";

import { renderGatewayErrorPage } from "../../src/fork/loopbackGateway/errorPage.ts";
import { startFakeGateway } from "../../src/fork/loopbackGateway/fakeGateway.testkit.ts";
import {
  makeLoopbackGatewayHost,
  makeProxyLoginListener,
} from "../../src/fork/loopbackGateway/LoopbackGatewayHost.ts";
import { makeTlsFixtures } from "../../src/fork/loopbackGateway/tlsFixtures.testkit.ts";

const outputDir = process.env.T3X_SMOKE_OUTPUT ?? "/tmp/t3x-p92/smoke-unset";
const TICKET = "smoke.ticket-Zq8vXk2LmN4pR7sT.signature-Wd5hYb3Fc9Gj1Ea";

interface Result {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const results: Array<Result> = [];
const note = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};
const check = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const until = async (condition: () => boolean, milliseconds: number): Promise<boolean> => {
  const deadline = Date.now() + milliseconds;
  while (!condition() && Date.now() < deadline) await sleep(25);
  return condition();
};
const withTimeout = <T>(promise: Promise<T>, milliseconds: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${milliseconds} ms`)), milliseconds),
    ),
  ]);
const scenario = async (name: string, run: () => Promise<string>): Promise<void> => {
  try {
    note(name, true, await withTimeout(run(), 30_000));
  } catch (error) {
    note(name, false, error instanceof Error ? error.message : String(error));
  }
};

interface Fixture {
  readonly port: number;
  readonly served: Array<{ readonly method: string; readonly url: string }>;
  readonly connections: () => number;
  readonly close: () => Promise<void>;
}

const listening: Array<NodeHttp.Server | NodeHttps.Server> = [];

const startFixture = async (
  handler: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
  options: { readonly tls?: { key: string; cert: string }; readonly websocket?: boolean } = {},
): Promise<Fixture> => {
  const served: Fixture["served"] = [];
  let connections = 0;
  const onRequest = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    served.push({ method: request.method ?? "", url: request.url ?? "" });
    response.setHeader("Access-Control-Allow-Origin", "*");
    handler(request, response);
  };
  const server =
    options.tls === undefined
      ? NodeHttp.createServer(onRequest)
      : NodeHttps.createServer(options.tls, onRequest);
  server.on("connection", () => {
    connections += 1;
  });
  if (options.websocket === true) {
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      served.push({ method: "UPGRADE", url: request.url ?? "" });
      sockets.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data) => ws.send(data.toString()));
      });
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  listening.push(server);
  return {
    port: (server.address() as NodeNet.AddressInfo).port,
    served,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const html = (body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const page =
  (body: string, head = "") =>
  (_request: unknown, response: NodeHttp.ServerResponse) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html(body, head));
  };

const windows: Array<BrowserWindow> = [];
const openWindow = (session: Session, webviewTag = false): BrowserWindow => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      session,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      webviewTag,
    },
  });
  windows.push(win);
  return win;
};

const load = (win: BrowserWindow, url: string): Promise<{ status: number | undefined }> =>
  new Promise((resolve, reject) => {
    let status: number | undefined;
    win.webContents.once("did-navigate", (_event, _url, code) => {
      status = code;
    });
    win.webContents.once("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame) reject(new Error(`load failed: ${description} (${code})`));
    });
    win.webContents.once("did-finish-load", () => resolve({ status }));
    void win.loadURL(url).catch(() => undefined);
  });

const evaluate = <T>(win: BrowserWindow, code: string): Promise<T> =>
  win.webContents.executeJavaScript(code, true) as Promise<T>;

const main = async (): Promise<void> => {
  app.dock?.hide();
  await app.whenReady();

  const fixtures = await makeTlsFixtures();
  const refusedPorts = new Set<number>();
  const gateway = await startFakeGateway({
    ticket: TICKET,
    refuse: (port) => (refusedPorts.has(port) ? "not-owned" : undefined),
  });
  const events: Array<Record<string, unknown>> = [];
  const host = makeLoopbackGatewayHost({
    emit: (event) => events.push(event as unknown as Record<string, unknown>),
    renderErrorPage: renderGatewayErrorPage,
  });
  const expiresAt = DateTime.makeUnsafe(Date.now() + 60 * 60_000);
  const credential = { ticket: Redacted.make(TICKET), expiresAt };

  // The same listener the app registers, with counters around it.
  const answerLogin = makeProxyLoginListener(host);
  let loginAnswered = 0;
  let loginIgnored = 0;
  app.on("login", (event, webContents, _details, authInfo, callback) => {
    answerLogin(event, webContents ?? undefined, authInfo, (username, password) => {
      loginAnswered += 1;
      callback(username, password);
    });
    if (!event.defaultPrevented) loginIgnored += 1;
  });

  // The https fixture is self-signed; the harness (not the app) trusts exactly that origin.
  const httpsPorts = new Set<number>();
  app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
    const port = Number(new URL(url).port);
    if (httpsPorts.has(port)) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  const attempts = (port: number) =>
    gateway.attempts.filter((attempt) => attempt.port === port).length;
  /** The fixture answered while the gateway saw nothing for its port: the request went direct. */
  const expectTunnelled = (name: string, fixture: Fixture) => {
    check(fixture.served.length > 0, `${name}: the fixture on ${fixture.port} saw no request`);
    check(
      attempts(fixture.port) > 0,
      `${name}: served ${fixture.served.length} request(s) with no tunnel (went direct)`,
    );
  };

  const ENV = "smoke-b";
  const defaultSession = electronSession.fromPartition("persist:smoke-default");
  const incognitoSession = electronSession.fromPartition("smoke-incognito");
  const controlSession = electronSession.fromPartition("persist:smoke-control");

  // The environment registers first, then each session is handed over before any page exists.
  const registered = await host.register({
    environmentId: ENV,
    httpBaseUrl: gateway.baseUrl,
    enabled: true,
    credential,
  });
  await host.installSession(ENV, defaultSession);
  await host.installSession(ENV, incognitoSession);
  console.log(`registered: ${JSON.stringify(registered)}`);

  await scenario("proxy rule per session", async () => {
    const proxied = [
      "http://localhost:1/",
      "http://127.0.0.1:1/",
      "http://[::1]:1/",
      "ws://localhost:1/",
      "https://localhost:1/",
    ];
    const direct = ["http://direct.test:1/", "https://example.com/"];
    const seen = new Set<string>();
    for (const session of [defaultSession, incognitoSession]) {
      for (const url of proxied) {
        const answer = await session.resolveProxy(url);
        check(/^PROXY 127\.0\.0\.1:\d+/u.test(answer), `${url} resolved to "${answer}"`);
        seen.add(answer);
      }
      for (const url of direct) {
        const answer = await session.resolveProxy(url);
        check(answer === "DIRECT", `${url} resolved to "${answer}" instead of DIRECT`);
      }
    }
    const control = await controlSession.resolveProxy("http://localhost:1/");
    check(control === "DIRECT", `control session resolved loopback to "${control}"`);
    return `loopback names go to ${[...seen].join(" | ")}; other hosts and the control session are DIRECT`;
  });

  await scenario("plain HTTP, origin kept, other session direct", async () => {
    const fixture = await startFixture((request, response) => {
      if (request.url === "/data") response.end("hello");
      else page("<p>ok</p>")(request, response);
    });
    const win = openWindow(defaultSession);
    await load(win, `http://localhost:${fixture.port}/`);
    const origin = await evaluate<string>(win, "location.origin");
    const data = await evaluate<string>(win, "fetch('/data').then((r) => r.text())");
    check(origin === `http://localhost:${fixture.port}`, `origin was ${origin}`);
    check(data === "hello", `fetch returned ${data}`);
    expectTunnelled("http", fixture);

    const before = attempts(fixture.port);
    const control = openWindow(controlSession);
    await load(control, `http://localhost:${fixture.port}/`);
    check(attempts(fixture.port) === before, "the session without the proxy opened a tunnel");
    return `origin ${origin}; ${attempts(fixture.port)} tunnel(s); the control session reached the fixture directly with no tunnel`;
  });

  await scenario("server-sent events arrive in order", async () => {
    const fixture = await startFixture((request, response) => {
      if (request.url !== "/sse") return page("<p>sse</p>")(request, response);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      let count = 0;
      const timer = setInterval(() => {
        count += 1;
        response.write(`data: ${count}\n\n`);
        if (count === 3) clearInterval(timer);
      }, 80);
      response.on("close", () => clearInterval(timer));
    });
    const win = openWindow(defaultSession);
    await load(win, `http://localhost:${fixture.port}/`);
    const received = await evaluate<Array<string>>(
      win,
      `new Promise((resolve, reject) => {
        const events = []; const source = new EventSource('/sse');
        source.onmessage = (event) => { events.push(event.data); if (events.length === 3) { source.close(); resolve(events); } };
        source.onerror = () => { if (events.length < 3) { source.close(); reject(new Error('sse error')); } };
      })`,
    );
    check(received.join(",") === "1,2,3", `events were ${received.join(",")}`);
    expectTunnelled("sse", fixture);
    return "events 1,2,3 in order";
  });

  await scenario("WebSocket", async () => {
    const fixture = await startFixture(page("<p>ws</p>"), { websocket: true });
    const win = openWindow(defaultSession);
    await load(win, `http://localhost:${fixture.port}/`);
    const opened = gateway.opened();
    const echoed = await evaluate<string>(
      win,
      `new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://localhost:${fixture.port}/ws');
        ws.onopen = () => ws.send('ping');
        ws.onmessage = (event) => { resolve(event.data); ws.close(); };
        ws.onerror = () => reject(new Error('websocket error'));
      })`,
    );
    check(echoed === "ping", `echoed ${echoed}`);
    check(
      fixture.served.some((entry) => entry.method === "UPGRADE"),
      "the fixture saw no upgrade",
    );
    check(gateway.opened() > opened, "the WebSocket did not open its own tunnel");
    return "echo over ws://localhost, one extra tunnel for the CONNECT";
  });

  await scenario("https://localhost (TLS end to end through the tunnel)", async () => {
    const fixture = await startFixture(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html('<p id="m">secure</p>'));
      },
      { tls: fixtures.selfSigned },
    );
    httpsPorts.add(fixture.port);
    const win = openWindow(defaultSession);
    await load(win, `https://localhost:${fixture.port}/`);
    const text = await evaluate<string>(win, "document.getElementById('m').textContent");
    const origin = await evaluate<string>(win, "location.origin");
    check(text === "secure", `page said ${text}`);
    check(origin === `https://localhost:${fixture.port}`, `origin was ${origin}`);
    expectTunnelled("https", fixture);
    return `loaded ${origin} over a CONNECT tunnel`;
  });

  await scenario("Service Worker requests", async () => {
    const upstream = await startFixture((request, response) =>
      response.end(`upstream:${request.url}`),
    );
    const fixture = await startFixture((request, response) => {
      if (request.url === "/sw.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end(`
          self.addEventListener('install', (event) => {
            event.waitUntil(fetch('http://localhost:${upstream.port}/from-sw-install').then(() => self.skipWaiting()));
          });
          self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
          self.addEventListener('fetch', (event) => {
            if (new URL(event.request.url).pathname === '/via-sw') {
              event.respondWith(fetch('http://localhost:${upstream.port}/via-sw-upstream'));
            }
          });`);
        return;
      }
      page("<p>sw</p>")(request, response);
    });
    const win = openWindow(defaultSession);
    await load(win, `http://localhost:${fixture.port}/`);
    const reply = await evaluate<string>(
      win,
      `navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)
        .then(() => new Promise((r) => setTimeout(r, 200)))
        .then(() => fetch('/via-sw')).then((r) => r.text())`,
    );
    check(reply === "upstream:/via-sw-upstream", `the page got ${reply}`);
    check(
      upstream.served.some((entry) => entry.url === "/from-sw-install"),
      "the worker's own fetch never arrived",
    );
    expectTunnelled("service worker", upstream);
    return `worker fetches reached ${upstream.served.map((entry) => entry.url).join(", ")} through ${attempts(upstream.port)} tunnel(s)`;
  });

  await scenario("prefetch, preconnect and dns-prefetch", async () => {
    const prefetched = await startFixture((_request, response) => response.end("prefetched"));
    const preconnected = await startFixture((_request, response) => response.end("pre"));
    const fixture = await startFixture(
      page(
        "<p>hints</p>",
        `<link rel="prefetch" href="http://localhost:${prefetched.port}/prefetched"><link rel="preconnect" href="http://localhost:${preconnected.port}"><link rel="dns-prefetch" href="http://localhost:${preconnected.port}">`,
      ),
    );
    const win = openWindow(defaultSession);
    await load(win, `http://localhost:${fixture.port}/`);
    await until(() => prefetched.served.length > 0, 3000);
    await sleep(300);
    const details: Array<string> = [];
    if (prefetched.served.length > 0) {
      check(attempts(prefetched.port) > 0, "prefetch reached the fixture directly");
      details.push(`prefetch served through ${attempts(prefetched.port)} tunnel(s)`);
    } else {
      details.push("prefetch: Chromium issued no request for the hint (nothing left the page)");
    }
    check(preconnected.connections() === 0, "preconnect opened a direct connection to the fixture");
    details.push(
      `preconnect: no direct connection (${attempts(preconnected.port)} tunnel(s): a preconnect to an http proxy only warms the proxy)`,
    );
    return details.join("; ");
  });

  await scenario("navigator.sendBeacon", async () => {
    const target = await startFixture((_request, response) => response.writeHead(204).end());
    const fixture = await startFixture(page("<p>beacon</p>"));
    const win = openWindow(defaultSession);
    await load(win, `http://localhost:${fixture.port}/`);
    const queued = await evaluate<boolean>(
      win,
      `navigator.sendBeacon('http://localhost:${target.port}/beacon', 'payload')`,
    );
    check(queued, "sendBeacon refused to queue");
    check(await until(() => target.served.length > 0, 5000), "the beacon never arrived");
    expectTunnelled("sendBeacon", target);
    return `beacon arrived through ${attempts(target.port)} tunnel(s)`;
  });

  await scenario("non-persistent (incognito) partition", async () => {
    const fixture = await startFixture((request, response) => {
      if (request.url === "/data") response.end("incognito-data");
      else page("<p>private</p>")(request, response);
    });
    const win = openWindow(incognitoSession);
    await load(win, `http://localhost:${fixture.port}/`);
    const data = await evaluate<string>(win, "fetch('/data').then((r) => r.text())");
    check(data === "incognito-data", `fetch returned ${data}`);
    expectTunnelled("incognito", fixture);
    return "loaded and fetched through the tunnel";
  });

  await scenario("a new profile's first navigation", async () => {
    const fixture = await startFixture(page("<p>first</p>"));
    const fresh = electronSession.fromPartition("persist:smoke-new-profile");
    await host.installSession(ENV, fresh);
    const rule = await fresh.resolveProxy(`http://localhost:${fixture.port}/`);
    check(
      /^PROXY 127\.0\.0\.1:\d+/u.test(rule),
      `the new profile resolved to "${rule}" before its first navigation`,
    );
    const win = openWindow(fresh);
    await load(win, `http://localhost:${fixture.port}/`);
    expectTunnelled("new profile", fixture);
    return `proxy rule "${rule}" was in place before the first navigation`;
  });

  await scenario("favicon fetch through session.fetch", async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/x-icon" });
      response.end(Buffer.alloc(64, 7));
    });
    const bytes = (
      await (
        await defaultSession.fetch(`http://localhost:${fixture.port}/favicon.ico`)
      ).arrayBuffer()
    ).byteLength;
    check(bytes === 64, `got ${bytes} bytes`);
    expectTunnelled("favicon", fixture);
    return "session.fetch of /favicon.ico went through the tunnel";
  });

  await scenario("download", async () => {
    const payload = Buffer.alloc(1024 * 1024);
    for (let at = 0; at < payload.length; at += 1) payload[at] = at % 251;
    const fixture = await startFixture((request, response) => {
      if (request.url !== "/file.bin") return page("<p>dl</p>")(request, response);
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="file.bin"',
        "Content-Length": payload.length,
      });
      response.end(payload);
    });
    const target = NodePath.join(outputDir, "downloaded.bin");
    const done = new Promise<string>((resolve) => {
      defaultSession.once("will-download", (_event, item) => {
        item.setSavePath(target);
        item.once("done", (_doneEvent, state) => resolve(state));
      });
    });
    const win = openWindow(defaultSession);
    await load(win, `http://localhost:${fixture.port}/`);
    win.webContents.downloadURL(`http://localhost:${fixture.port}/file.bin`);
    const state = await done;
    check(state === "completed", `download ended ${state}`);
    check(NodeFS.readFileSync(target).equals(payload), "the downloaded bytes differ");
    expectTunnelled("download", fixture);
    return "1 MiB downloaded intact through the tunnel";
  });

  await scenario("a non-loopback host stays direct", async () => {
    const fixture = await startFixture(page('<p id="d">direct</p>'));
    const win = openWindow(defaultSession);
    await load(win, `http://direct.test:${fixture.port}/`);
    const text = await evaluate<string>(win, "document.getElementById('d').textContent");
    check(text === "direct", `page said ${text}`);
    check(fixture.served.length > 0, "the fixture saw no request");
    check(attempts(fixture.port) === 0, "a non-loopback host was tunnelled");
    return "direct.test reached the fixture without a tunnel";
  });

  await scenario("a refused port shows the page and tells the renderer", async () => {
    const fixture = await startFixture(page("<p>never</p>"));
    refusedPorts.add(fixture.port);
    const win = openWindow(defaultSession);
    const { status } = await load(win, `http://localhost:${fixture.port}/`);
    const text = await evaluate<string>(win, "document.body.innerText");
    check(status === 403, `status was ${status}`);
    check(text.includes(`localhost:${fixture.port}`), `page text was "${text}"`);
    check(fixture.served.length === 0, "the fixture was reached");
    await until(
      () => events.some((event) => event.type === "denied" && event.port === fixture.port),
      2000,
    );
    const denied = events.find((event) => event.type === "denied" && event.port === fixture.port);
    check(denied !== undefined, "no denied event");
    check(
      denied?.mainFrame === true && denied?.code === "not-owned",
      `event was ${JSON.stringify(denied)}`,
    );
    check(
      denied?.webContentsId === win.webContents.id,
      `webContentsId was ${denied?.webContentsId}`,
    );
    return `403 page; event ${JSON.stringify({ code: denied?.code, mainFrame: denied?.mainFrame, webContentsId: denied?.webContentsId })}`;
  });

  await scenario("a refused https port fails the tunnel and tells the renderer", async () => {
    const fixture = await startFixture(page("<p>never</p>"), { tls: fixtures.selfSigned });
    httpsPorts.add(fixture.port);
    refusedPorts.add(fixture.port);
    const win = openWindow(defaultSession);
    const failure = await load(win, `https://localhost:${fixture.port}/`).then(
      () => "loaded",
      (error: Error) => error.message,
    );
    check(failure.startsWith("load failed"), `navigation ${failure}`);
    await until(
      () => events.some((event) => event.type === "denied" && event.port === fixture.port),
      2000,
    );
    const denied = events.find((event) => event.type === "denied" && event.port === fixture.port);
    check(
      denied?.mainFrame === false && denied?.code === "not-owned",
      `event was ${JSON.stringify(denied)}`,
    );
    check(fixture.served.length === 0 && fixture.connections() === 0, "the fixture was reached");
    return `${failure}; event ${JSON.stringify({ code: denied?.code, mainFrame: denied?.mainFrame })}`;
  });

  await scenario("an environment without a ticket answers 503 and asks for one", async () => {
    const pendingSession = electronSession.fromPartition("persist:smoke-pending");
    await host.register({
      environmentId: "smoke-pending",
      httpBaseUrl: gateway.baseUrl,
      enabled: true,
    });
    await host.installSession("smoke-pending", pendingSession);
    const fixture = await startFixture(page("<p>never</p>"));
    const win = openWindow(pendingSession);
    const { status } = await load(win, `http://localhost:${fixture.port}/`);
    check(status === 503, `status was ${status}`);
    check(fixture.served.length === 0, "the fixture was reached");
    check(
      events.some(
        (event) => event.type === "ticket-needed" && event.environmentId === "smoke-pending",
      ),
      "no ticket-needed event",
    );
    return "503 page, ticket-needed event, fixture untouched";
  });

  await scenario("webview in a host window", async () => {
    const fixture = await startFixture(page('<p id="w">in webview</p>'));
    const before = attempts(fixture.port);
    const hostWindow = openWindow(electronSession.fromPartition("persist:smoke-host"), true);
    await load(
      hostWindow,
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<webview id="g" partition="persist:smoke-default" src="http://localhost:${fixture.port}/" style="width:600px;height:400px"></webview>`,
      )}`,
    );
    const text = await evaluate<string>(
      hostWindow,
      `new Promise((resolve) => { const view = document.getElementById('g');
        view.addEventListener('dom-ready', () => view.executeJavaScript("document.getElementById('w').textContent").then(resolve));
      })`,
    );
    check(text === "in webview", `webview said ${text}`);
    check(attempts(fixture.port) > before, "the webview did not use the tunnel");
    return "the <webview> guest in the default partition was proxied";
  });

  await scenario("stop forwarding, then resume", async () => {
    const fixture = await startFixture((request, response) => {
      if (request.url?.startsWith("/data")) response.end("data");
      else page("<p>reverse</p>")(request, response);
    });
    const win = openWindow(defaultSession);
    await load(win, `http://localhost:${fixture.port}/`);
    const proxiedBefore = await defaultSession.resolveProxy(`http://localhost:${fixture.port}/`);
    const tunnelsBefore = attempts(fixture.port);
    check(tunnelsBefore > 0, "the first load did not use the tunnel");

    const off = await host.setEnabled(ENV, false);
    check(off?.state === "disabled-by-user", `status was ${JSON.stringify(off)}`);
    const rule = await defaultSession.resolveProxy(`http://localhost:${fixture.port}/`);
    check(rule === "DIRECT", `after stopping the rule was "${rule}"`);
    const direct = await evaluate<string>(win, "fetch('/data').then((r) => r.text())");
    check(direct === "data", `direct fetch returned ${direct}`);
    check(
      attempts(fixture.port) === tunnelsBefore,
      "a request opened a tunnel after forwarding was stopped",
    );

    const on = await host.setEnabled(ENV, true);
    check(on?.state === "active", `status was ${JSON.stringify(on)}`);
    const rule2 = await defaultSession.resolveProxy(`http://localhost:${fixture.port}/`);
    check(/^PROXY 127\.0\.0\.1:\d+/u.test(rule2), `after resuming the rule was "${rule2}"`);
    check(rule2 !== proxiedBefore, "the proxy was not replaced by a new one");
    const again = await evaluate<string>(win, "fetch('/data?again').then((r) => r.text())");
    check(again === "data", `fetch after resuming returned ${again}`);
    check(attempts(fixture.port) > tunnelsBefore, "the fetch after resuming did not use a tunnel");
    return `off: DIRECT, no new tunnel; on: "${rule2}" (was "${proxiedBefore}"), tunnel used again`;
  });

  await scenario("the proxy password is only ever answered to our proxy", async () => {
    check(loginAnswered > 0, "the proxy was never challenged");
    check(loginIgnored === 0, `${loginIgnored} challenge(s) were not answered by the gateway`);
    return `${loginAnswered} challenge(s) answered, none left over`;
  });

  await scenario("the ticket is nowhere in the harness output", async () => {
    const everything = JSON.stringify({ events, results });
    check(!everything.includes(TICKET), "the ticket appears in events or results");
    check(
      !everything.includes(TICKET.slice(4, 30)),
      "part of the ticket appears in events or results",
    );
    return "events and results do not contain it";
  });

  await host.dispose();
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  await gateway.close();
  await Promise.all(
    listening.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  fixtures.dispose();
  NodeFS.writeFileSync(NodePath.join(outputDir, "results.json"), JSON.stringify(results, null, 2));
  NodeFS.writeFileSync(NodePath.join(outputDir, "events.json"), JSON.stringify(events, null, 2));
  app.exit(results.every((result) => result.ok) ? 0 : 1);
};

main().catch((error: unknown) => {
  console.error(
    `harness crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  NodeFS.mkdirSync(outputDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(outputDir, "results.json"), JSON.stringify(results, null, 2));
  app.exit(1);
});
