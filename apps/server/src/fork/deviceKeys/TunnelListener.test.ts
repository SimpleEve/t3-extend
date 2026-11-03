// fork: 8.2's first deliverable. A real main listener and a real tunnel listener over the same
// router, exercised with plain sockets; every assertion maps to a line of design 3.11 / 8c.
// @effect-diagnostics nodeBuiltinImport:off -- Real loopback sockets.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServer from "effect/http/HttpServer";

import * as TunnelListener from "./TunnelListener.ts";
import {
  DEV_TOKEN,
  encodeJson,
  Harness,
  TUNNEL_ORIGIN,
  layerHarness,
  makeDpopSigner,
  send,
  type DpopSigner,
} from "./tunnelHarness.testkit.ts";

const MAIN_HOST = (port: number) => `127.0.0.1:${port}`;
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" } as const;
const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000));

const bootstrapExchange = (credential: string) =>
  form({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });

/** Exchanges the dev credential for a DPoP-bound session over `port`, signing for `origin`. */
const mintSession = Effect.fn("mintSession")(function* (
  port: number,
  origin: string,
  signer: DpopSigner,
  extraHeaders: Readonly<Record<string, string>> = {},
) {
  const response = yield* send(port, {
    method: "POST",
    path: "/oauth/token",
    headers: {
      ...FORM_HEADERS,
      dpop: signer.proof({
        method: "POST",
        url: `${origin}/oauth/token`,
        iat: yield* nowSeconds,
      }),
      ...extraHeaders,
    },
    body: bootstrapExchange(DEV_TOKEN),
  });
  return response;
});

describe("tunnel listener skeleton (design 3.11 / 8c)", () => {
  describe("connectivity and shared middleware", () => {
    it.live("serves the same routes on the main and the tunnel listener", () =>
      Effect.gen(function* () {
        const harness = yield* Harness;
        for (const port of [harness.mainPort, harness.tunnelPort]) {
          const response = yield* send(port, { path: "/test/inspect" });
          assert.equal(response.status, 200);
        }
        assert.deepEqual(harness.seen, ["/test/inspect", "/test/inspect"]);
        assert.notEqual(harness.mainPort, harness.tunnelPort);
      }).pipe(Effect.provide(layerHarness)),
    );

    it.live(
      "runs tunnel HTTP requests through the same global middleware as the main listener",
      () =>
        Effect.gen(function* () {
          const harness = yield* Harness;
          const preflight = {
            method: "OPTIONS",
            path: "/oauth/token",
            headers: {
              origin: "http://127.0.0.1:5173",
              "access-control-request-method": "POST",
              "access-control-request-headers": "dpop",
            },
          } as const;
          const main = yield* send(harness.mainPort, preflight);
          const tunnel = yield* send(harness.tunnelPort, preflight);
          assert.equal(tunnel.status, main.status);
          assert.equal(
            tunnel.headers["access-control-allow-headers"],
            main.headers["access-control-allow-headers"],
          );
          assert.isDefined(tunnel.headers["access-control-allow-origin"]);

          // The rate-limit middleware (the other global one that matters here) sees tunnel requests too.
          const failed = yield* send(harness.tunnelPort, {
            method: "POST",
            path: "/oauth/token",
            headers: { ...FORM_HEADERS, "x-t3x-client-ip": "203.0.113.7" },
            body: bootstrapExchange("not-a-credential"),
          });
          assert.equal(failed.status, 401);
          assert.deepEqual(harness.limiterClients, ["forwarded:203.0.113.7"]);
          assert.deepEqual(harness.seen, ["/oauth/token"]);
        }).pipe(Effect.provide(layerHarness)),
    );

    it.live(
      "upgrades a DPoP-bound WebSocket on the tunnel listener, through the same middleware",
      () =>
        Effect.gen(function* () {
          const harness = yield* Harness;
          const signer = makeDpopSigner();
          const session = yield* mintSession(harness.tunnelPort, TUNNEL_ORIGIN, signer);
          assert.equal(session.status, 200);
          const accessToken = (session.json() as { access_token: string }).access_token;

          const ticketPath = "/api/auth/websocket-ticket/rpc";
          const ticketResponse = yield* send(harness.tunnelPort, {
            method: "POST",
            path: ticketPath,
            headers: {
              authorization: `DPoP ${accessToken}`,
              dpop: signer.proof({
                method: "POST",
                url: `${TUNNEL_ORIGIN}${ticketPath}`,
                accessToken,
                iat: yield* nowSeconds,
              }),
            },
          });
          assert.equal(ticketResponse.status, 200);
          const ticket = (ticketResponse.json() as { ticket: string }).ticket;

          const proof = signer.proof({
            method: "GET",
            url: `${TUNNEL_ORIGIN}/test/ws`,
            accessToken: ticket,
            iat: yield* nowSeconds,
          });
          const url = `ws://127.0.0.1:${harness.tunnelPort}/test/ws?wsTicket=${encodeURIComponent(ticket)}&dpop=${encodeURIComponent(proof)}`;
          const greeting = yield* Effect.promise(
            () =>
              new Promise<string>((resolve, reject) => {
                const socket = new WebSocket(url);
                socket.addEventListener("message", (event) => resolve(String(event.data)));
                socket.addEventListener("error", () =>
                  reject(new Error("WebSocket upgrade failed")),
                );
                socket.addEventListener("close", () => reject(new Error("WebSocket closed early")));
              }),
          );
          assert.isAbove(greeting.length, 0);
          assert.include(
            harness.seen,
            `/test/ws?wsTicket=${encodeURIComponent(ticket)}&dpop=${encodeURIComponent(proof)}`,
          );
        }).pipe(Effect.provide(layerHarness)),
    );
  });

  describe("what the application sees on the tunnel listener", () => {
    it.live("verifies the DPoP htu against the https tunnel origin, and only there", () =>
      Effect.gen(function* () {
        const harness = yield* Harness;
        // A proof for the public origin is accepted on the tunnel listener...
        const viaTunnel = yield* mintSession(harness.tunnelPort, TUNNEL_ORIGIN, makeDpopSigner());
        assert.equal(viaTunnel.status, 200);
        assert.equal((viaTunnel.json() as { token_type: string }).token_type, "DPoP");
        // ...is rejected by the main listener, which still derives http://127.0.0.1:<port>...
        const onMain = yield* mintSession(harness.mainPort, TUNNEL_ORIGIN, makeDpopSigner());
        assert.equal(onMain.status, 401);
        // ...and the main listener keeps accepting proofs for its own origin.
        const own = yield* mintSession(
          harness.mainPort,
          `http://${MAIN_HOST(harness.mainPort)}`,
          makeDpopSigner(),
          { host: MAIN_HOST(harness.mainPort) },
        );
        assert.equal(own.status, 200);
      }).pipe(Effect.provide(layerHarness)),
    );

    it.live("derives the request URL, MCP issuer and resource from the tunnel origin", () =>
      Effect.gen(function* () {
        const harness = yield* Harness;
        const inspect = yield* send(harness.tunnelPort, {
          path: "/test/inspect",
          headers: { "x-forwarded-proto": "http", host: "anything.example.test" },
        });
        assert.equal((inspect.json() as { url: string }).url, `${TUNNEL_ORIGIN}/test/inspect`);

        const authorizationServer = yield* send(harness.tunnelPort, {
          path: "/.well-known/oauth-authorization-server",
        });
        assert.equal((authorizationServer.json() as { issuer: string }).issuer, TUNNEL_ORIGIN);
        const resource = yield* send(harness.tunnelPort, {
          path: "/.well-known/oauth-protected-resource/mcp",
        });
        assert.deepEqual(
          {
            resource: (resource.json() as { resource: string }).resource,
            servers: (resource.json() as { authorization_servers: Array<string> })
              .authorization_servers,
          },
          { resource: `${TUNNEL_ORIGIN}/mcp`, servers: [TUNNEL_ORIGIN] },
        );

        const onMain = yield* send(harness.mainPort, {
          path: "/.well-known/oauth-authorization-server",
        });
        assert.equal(
          (onMain.json() as { issuer: string }).issuer,
          `http://${MAIN_HOST(harness.mainPort)}`,
        );
      }).pipe(Effect.provide(layerHarness)),
    );

    it.live(
      "keys the rate limiter by the client address in X-T3x-Client-IP and hides the headers",
      () =>
        Effect.gen(function* () {
          const harness = yield* Harness;
          const failedExchange = (headers: Record<string, string>) =>
            send(harness.tunnelPort, {
              method: "POST",
              path: "/oauth/token",
              headers: { ...FORM_HEADERS, ...headers },
              body: bootstrapExchange("not-a-credential"),
            });
          // Caddy's container is the right-most X-Forwarded-For entry after frps; it must not be the key.
          yield* failedExchange({
            "x-t3x-client-ip": "203.0.113.7",
            "x-forwarded-for": "203.0.113.7, 192.168.80.4",
          });
          yield* failedExchange({ "x-t3x-client-ip": "2001:db8::9" });
          yield* failedExchange({ "x-t3x-client-ip": "not-an-ip" });
          yield* failedExchange({});
          yield* failedExchange({ "x-t3x-client-ip": "203.0.113.7, 198.51.100.1" });
          assert.deepEqual(harness.limiterClients, [
            "forwarded:203.0.113.7",
            "forwarded:2001:db8::9",
            "forwarded:tunnel-unknown",
            "forwarded:tunnel-unknown",
            "forwarded:tunnel-unknown",
          ]);

          const inspect = yield* send(harness.tunnelPort, {
            path: "/test/inspect",
            headers: {
              "x-t3x-client-ip": "203.0.113.7",
              "x-forwarded-for": "203.0.113.7, 192.168.80.4",
              "x-forwarded-port": "443",
              forwarded: "for=203.0.113.7",
              "x-real-ip": "203.0.113.7",
            },
          });
          const { headers } = inspect.json() as { headers: Record<string, string> };
          assert.deepEqual(
            {
              host: headers.host,
              forwardedHost: headers["x-forwarded-host"],
              forwardedProto: headers["x-forwarded-proto"],
              forwardedFor: headers["x-forwarded-for"],
              dropped: [
                headers["x-t3x-client-ip"],
                headers["x-forwarded-port"],
                headers.forwarded,
                headers["x-real-ip"],
              ],
            },
            {
              host: "laptop.t3.example.test",
              forwardedHost: "laptop.t3.example.test",
              forwardedProto: "https",
              forwardedFor: "203.0.113.7",
              dropped: [undefined, undefined, undefined, undefined],
            },
          );
        }).pipe(Effect.provide(layerHarness)),
    );

    it.live("accepts a browser session whose Origin is the tunnel origin", () =>
      Effect.gen(function* () {
        const harness = yield* Harness;
        const login = yield* send(harness.mainPort, {
          method: "POST",
          path: "/api/auth/browser-session",
          headers: { "content-type": "application/json" },
          body: encodeJson({ credential: DEV_TOKEN }),
        });
        const setCookie = login.headers["set-cookie"];
        const cookie = (Array.isArray(setCookie) ? setCookie : [])
          .find((value) => value.includes(`=${DEV_TOKEN};`))
          ?.split(";", 1)[0];
        assert.isDefined(cookie);
        const authenticatedVia = (port: number, origin: string) =>
          send(port, {
            path: "/api/auth/session",
            headers: { cookie: cookie ?? "", origin },
          }).pipe(
            Effect.map((response) => (response.json() as { authenticated: boolean }).authenticated),
          );

        assert.equal(yield* authenticatedVia(harness.tunnelPort, TUNNEL_ORIGIN), true);
        assert.equal(
          yield* authenticatedVia(harness.tunnelPort, "https://evil.example.test"),
          false,
        );
        // The same Origin is not this server's own on the main listener.
        assert.equal(yield* authenticatedVia(harness.mainPort, TUNNEL_ORIGIN), false);
      }).pipe(Effect.provide(layerHarness)),
    );
  });

  describe("boundaries", () => {
    it.live("ignores a forged X-T3x-Client-IP on the main listener", () =>
      Effect.gen(function* () {
        const harness = yield* Harness;
        const failedExchange = (headers: Record<string, string>) =>
          send(harness.mainPort, {
            method: "POST",
            path: "/oauth/token",
            headers: { ...FORM_HEADERS, ...headers },
            body: bootstrapExchange("not-a-credential"),
          });
        // Loopback with no forwarding header is this machine's own call: no bucket at all, however
        // the attacker labels it.
        yield* failedExchange({ "x-t3x-client-ip": "198.51.100.77" });
        assert.deepEqual(harness.limiterClients, []);
        // Upstream's own rule still picks the bucket from X-Forwarded-For; the forged header is not consulted.
        yield* failedExchange({
          "x-t3x-client-ip": "198.51.100.77",
          "x-forwarded-for": "198.51.100.5",
        });
        assert.deepEqual(harness.limiterClients, ["forwarded:198.51.100.5"]);
        // And an unrewritten request is not mistaken for a tunnel request: it keeps its own Host.
        const inspect = yield* send(harness.mainPort, {
          path: "/test/inspect",
          headers: { "x-t3x-client-ip": "198.51.100.77", "x-forwarded-proto": "https" },
        });
        const body = inspect.json() as { url: string; headers: Record<string, string> };
        assert.equal(body.url, `https://${MAIN_HOST(harness.mainPort)}/test/inspect`);
        assert.equal(body.headers["x-t3x-client-ip"], "198.51.100.77");
      }).pipe(Effect.provide(layerHarness)),
    );

    it.live("answers 503 tunnel_not_ready before the application when there is no membership", () =>
      Effect.gen(function* () {
        const harness = yield* Harness;
        harness.setTunnelOrigin(Option.none());
        const response = yield* send(harness.tunnelPort, { path: "/test/inspect" });
        assert.equal(response.status, 503);
        assert.deepEqual(response.json(), { error: "tunnel_not_ready" });
        const upgrade = yield* send(harness.tunnelPort, {
          path: "/test/ws",
          headers: { connection: "Upgrade", upgrade: "websocket" },
        });
        assert.equal(upgrade.status, 503);
        // Neither request reached a route or a global middleware.
        assert.deepEqual(harness.seen, []);
        assert.deepEqual(harness.limiterClients, []);
        // The main listener is unaffected.
        assert.equal((yield* send(harness.mainPort, { path: "/test/inspect" })).status, 200);
      }).pipe(Effect.provide(layerHarness)),
    );

    it.live("binds only to loopback and does not replace the HttpServer other layers see", () =>
      Effect.gen(function* () {
        const harness = yield* Harness;
        const seenByOthers = yield* HttpServer.HttpServer;
        assert.equal(
          "port" in seenByOthers.address ? seenByOthers.address.port : -1,
          harness.mainPort,
        );
        const listener = yield* TunnelListener.TunnelListener;
        assert.equal(yield* listener.port, harness.tunnelPort);

        // Another interface of this machine must not reach the tunnel port.
        const external = Object.values(NodeOS.networkInterfaces())
          .flat()
          .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
        if (external === undefined) return;
        const code = yield* Effect.promise(
          () =>
            new Promise<string>((resolve) => {
              const probe = NodeNet.connect({ host: external.address, port: harness.tunnelPort });
              probe.on("connect", () => {
                probe.destroy();
                resolve("connected");
              });
              probe.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
            }),
        );
        assert.equal(code, "ECONNREFUSED");
      }).pipe(Effect.provide(layerHarness)),
    );
  });
});
