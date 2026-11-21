// fork: upstream's tunnel route with the exclusion hook: a refused port never sees a byte, and an
// HTTP request on the tunnel gets a page that says why.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as PreviewTunnel from "../../preview/PreviewTunnel.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { pageLanguage } from "./refusalPage.ts";
import { TunnelExclusions, type TunnelRefusal } from "./TunnelExclusions.ts";

const listen = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: NodeNet.Server; received: Buffer[]; arrived: Promise<void> }>(
        (resolve) => {
          const received: Buffer[] = [];
          const arrived = Promise.withResolvers<void>();
          const server = NodeNet.createServer((socket) => {
            socket.on("data", (chunk) => {
              received.push(chunk);
              arrived.resolve();
            });
            socket.on("error", () => undefined);
          });
          server.listen(0, "127.0.0.1", () =>
            resolve({ server, received, arrived: arrived.promise }),
          );
        },
      ),
  ),
  ({ server }) =>
    Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
).pipe(
  Effect.map(({ server, received, arrived }) => ({
    port: (server.address() as NodeNet.AddressInfo).port,
    received,
    arrived,
  })),
);

const serveTunnel = (refuse: (port: number) => TunnelRefusal | null) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(PreviewTunnel.routeLayer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(
          PreviewTunnel.layer.pipe(
            Layer.provide(
              Layer.mock(ServerSettingsService, {
                managedPolicy: undefined,
                getSettings: Effect.succeed({
                  ...DEFAULT_SERVER_SETTINGS,
                  enablePreviewTunnel: true,
                }),
                subscribeChanges: Effect.succeed(Stream.never),
              }),
            ),
          ),
        ),
        Layer.provide(
          Layer.succeed(TunnelExclusions, { check: (port) => Effect.succeed(refuse(port)) }),
        ),
        Layer.provide(
          Layer.mock(SessionStore.SessionStore, {
            cookieName: "t3-session",
            legacyCookieName: undefined,
            awaitInvalidation: () => Effect.never,
          }),
        ),
        Layer.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("tunnel-test"),
                subject: "tunnel-test",
                method: "bearer-access-token",
                scopes: [AuthOrchestrationReadScope, AuthTerminalOperateScope],
              }),
          }),
        ),
      ),
    );
    const origin = new URL(
      HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address),
    );
    return `ws://${origin.host}`;
  });

/** Sends `bytes` through a tunnel to `port` and collects what comes back until it closes. */
const exchange = (origin: string, port: number, bytes: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocket(`${origin}/api/preview/tunnel?port=${port}`)),
    (socket) => Effect.sync(() => socket.terminate()),
  ).pipe(
    Effect.flatMap((client) =>
      Effect.promise(
        () =>
          new Promise<string>((resolve, reject) => {
            const received: Buffer[] = [];
            client.on("open", () => client.send(Buffer.from(bytes)));
            client.on("message", (data: Buffer) => received.push(data));
            client.on("close", () => resolve(Buffer.concat(received).toString("utf8")));
            client.on("error", reject);
          }),
      ),
    ),
  );

const GET = (language: string) =>
  `GET / HTTP/1.1\r\nhost: localhost\r\naccept-language: ${language}\r\n\r\n`;

it.effect("answers an HTTP request to a refused port with a page, and never reaches the port", () =>
  Effect.gen(function* () {
    const service = yield* listen;
    const origin = yield* serveTunnel((port) =>
      port === service.port ? { code: "debug-process" } : null,
    );
    const english = yield* exchange(origin, service.port, GET("en-US,en;q=0.9"));
    expect(english).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/u);
    expect(english).toContain(`Can't forward localhost:${service.port}`);
    expect(english).toContain("--inspect");
    const chinese = yield* exchange(origin, service.port, GET("zh-CN,zh;q=0.9"));
    expect(chinese).toContain(`无法转发 localhost:${service.port}`);
    expect(service.received).toEqual([]);
  }),
);

it.effect("closes a refused tunnel that does not speak HTTP, such as TLS", () =>
  Effect.gen(function* () {
    const service = yield* listen;
    const origin = yield* serveTunnel(() => ({ code: "reserved" }));
    const answer = yield* exchange(
      origin,
      service.port,
      "\u0016\u0003\u0001\u0002\u0000\u0001\u0000\u0001ü\u0003\u0003",
    );
    expect(answer).toBe("");
    expect(service.received).toEqual([]);
  }),
);

it.effect("pipes a port that is not refused through to its service", () =>
  Effect.gen(function* () {
    const service = yield* listen;
    const origin = yield* serveTunnel(() => null);
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocket(`${origin}/api/preview/tunnel?port=${service.port}`)),
      (socket) => Effect.sync(() => socket.terminate()),
    );
    client.on("open", () => client.send(Buffer.from(GET("en"))));
    yield* Effect.promise(() => service.arrived);
    expect(Buffer.concat(service.received).toString("utf8")).toBe(GET("en"));
  }),
);

it("picks the page's language from the request's first choice", () => {
  expect(pageLanguage("GET / HTTP/1.1\r\nAccept-Language: zh-Hans-CN, en\r\n\r\n")).toBe("zh");
  expect(pageLanguage("GET / HTTP/1.1\r\naccept-language: en-GB, zh;q=0.5\r\n\r\n")).toBe("en");
  expect(pageLanguage("GET / HTTP/1.1\r\n\r\n")).toBe("en");
});
