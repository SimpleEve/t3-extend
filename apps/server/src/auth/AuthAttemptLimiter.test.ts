import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AuthAttemptLimiter from "./AuthAttemptLimiter.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

const LIMITS: AuthAttemptLimiter.AuthAttemptLimits = {
  maxFailures: 3,
  window: Duration.minutes(1),
  lockout: Duration.seconds(60),
  maxClients: 10_000,
};

describe("AuthAttemptLimiter", () => {
  it.effect("locks one client after its failure budget and reopens when the lockout ends", () =>
    Effect.gen(function* () {
      const limiter = yield* AuthAttemptLimiter.make(LIMITS);
      yield* limiter.recordFailure("a");
      yield* limiter.recordFailure("a");
      expect(yield* limiter.check("a")).toEqual({ _tag: "Allowed" });

      yield* limiter.recordFailure("a");
      expect(yield* limiter.check("a")).toEqual({ _tag: "Locked", retryAfterSeconds: 60 });
      expect(yield* limiter.check("b")).toEqual({ _tag: "Allowed" });

      yield* TestClock.adjust(Duration.seconds(45));
      expect(yield* limiter.check("a")).toEqual({ _tag: "Locked", retryAfterSeconds: 15 });

      yield* TestClock.adjust(Duration.seconds(15));
      expect(yield* limiter.check("a")).toEqual({ _tag: "Allowed" });
      // The window starts fresh, so one more failure does not lock again.
      yield* limiter.recordFailure("a");
      expect(yield* limiter.check("a")).toEqual({ _tag: "Allowed" });
    }),
  );

  it.effect("forgets failures older than the window", () =>
    Effect.gen(function* () {
      const limiter = yield* AuthAttemptLimiter.make(LIMITS);
      yield* limiter.recordFailure("a");
      yield* limiter.recordFailure("a");
      yield* TestClock.adjust(Duration.seconds(61));
      yield* limiter.recordFailure("a");
      expect(yield* limiter.check("a")).toEqual({ _tag: "Allowed" });
    }),
  );

  it.effect("drops the least recently failing client past the tracking cap", () =>
    Effect.gen(function* () {
      const limiter = yield* AuthAttemptLimiter.make({ ...LIMITS, maxClients: 2 });
      yield* limiter.recordFailure("a");
      yield* limiter.recordFailure("a");
      yield* limiter.recordFailure("b");
      yield* limiter.recordFailure("b");
      yield* limiter.recordFailure("c");
      // "a" was dropped, so its earlier failures no longer count; "b" was kept.
      yield* limiter.recordFailure("a");
      expect(yield* limiter.check("a")).toEqual({ _tag: "Allowed" });
      yield* limiter.recordFailure("c");
      yield* limiter.recordFailure("c");
      expect(yield* limiter.check("c")).toEqual({ _tag: "Locked", retryAfterSeconds: 60 });
      // Tracking "a" and "c" evicted "b".
      yield* limiter.recordFailure("b");
      expect(yield* limiter.check("b")).toEqual({ _tag: "Allowed" });
    }),
  );

  it("limits only the endpoints that spend a pairing code", () => {
    expect(
      [
        ["POST", "/oauth/token"],
        ["POST", "/oauth/token?x=1"],
        ["POST", "/api/auth/browser-session"],
        ["POST", "/oauth/mcp/decision"],
        ["GET", "/oauth/token"],
        ["GET", "/api/auth/session"],
        ["POST", "/api/auth/websocket-ticket"],
        ["POST", "/oauth/mcp/approval"],
        ["POST", "/oauth/mcp/token"],
      ].map(([method, url]) => AuthAttemptLimiter.rejectedCodeStatus(method!, url!)),
    ).toEqual([401, 401, 401, 400, undefined, undefined, undefined, undefined, undefined]);
  });

  it("buckets by the proxy-appended forwarded entry, else the socket, and exempts local calls", () => {
    expect(
      [
        { remoteAddress: "127.0.0.1", forwardedFor: undefined },
        { remoteAddress: "::1", forwardedFor: undefined },
        { remoteAddress: "::ffff:127.0.0.1", forwardedFor: undefined },
        { remoteAddress: "127.0.0.1", forwardedFor: "203.0.113.7" },
        { remoteAddress: "127.0.0.1", forwardedFor: "198.51.100.1, 203.0.113.7 " },
        { remoteAddress: "127.0.0.1", forwardedFor: " , " },
        { remoteAddress: "192.168.1.20", forwardedFor: undefined },
        { remoteAddress: undefined, forwardedFor: undefined },
      ].map(AuthAttemptLimiter.clientKey),
    ).toEqual([
      null,
      null,
      null,
      "forwarded:203.0.113.7",
      "forwarded:203.0.113.7",
      null,
      "socket:192.168.1.20",
      "socket:unknown",
    ]);
  });
});

const layerLimiterMiddleware = AuthAttemptLimiter.middleware.pipe(
  Layer.provide(
    Layer.effect(AuthAttemptLimiter.AuthAttemptLimiter, AuthAttemptLimiter.make(LIMITS)),
  ),
);

// Every request reaches the server from loopback, as it does through a reverse tunnel.
const fromLoopbackSocket = (request: HttpServerRequest.HttpServerRequest) =>
  request.modify({ remoteAddress: Option.some("127.0.0.1") });

const forwardedFor = (client: string | undefined): Record<string, string> =>
  client === undefined ? {} : { "x-forwarded-for": client };

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-limit-test-" });
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provide(layerLimiterMiddleware),
  Layer.provideMerge(
    EnvironmentAuth.layer.pipe(
      Layer.provide(ManagedPolicy.layerTest()),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(layerConfig),
    ),
  ),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const tokenExchange = (subjectToken: string, client: string | undefined, scope?: string) =>
  new Request("http://127.0.0.1/oauth/token", {
    method: "POST",
    headers: forwardedFor(client),
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: subjectToken,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      ...(scope === undefined ? {} : { scope }),
    }),
  });

const ATTACKER = "198.51.100.9, 203.0.113.66";
const OTHER_CLIENT = "203.0.113.20";

const layerStubCodeRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/oauth/token", HttpServerResponse.empty({ status: 401 })),
  HttpRouter.add("POST", "/api/auth/browser-session", HttpServerResponse.empty({ status: 401 })),
  HttpRouter.add("POST", "/oauth/mcp/decision", HttpServerResponse.empty({ status: 400 })),
).pipe(Layer.provide(layerLimiterMiddleware));

describe("AuthAttemptLimiter middleware", () => {
  it.effect.each([
    ["/oauth/token", 401],
    ["/api/auth/browser-session", 401],
    ["/oauth/mcp/decision", 400],
  ] as const)("locks only the client that keeps failing on %s", ([path, rejected]) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(layerStubCodeRoutes, {
          disableLogger: true,
          middleware: (effect) =>
            Effect.updateService(effect, HttpServerRequest.HttpServerRequest, fromLoopbackSocket),
        }),
      ),
      (web) =>
        Effect.promise(async () => {
          const post = async (client: string | undefined) => {
            const request = new Request(`http://127.0.0.1${path}`, {
              method: "POST",
              headers: forwardedFor(client),
            });
            return (await web.handler(request)).status;
          };
          for (let attempt = 0; attempt < LIMITS.maxFailures; attempt += 1) {
            expect(await post(ATTACKER)).toBe(rejected);
          }
          expect(await post(ATTACKER)).toBe(429);
          expect(await post(OTHER_CLIENT)).toBe(rejected);
          // This machine's own calls never spend a budget.
          for (let attempt = 0; attempt <= LIMITS.maxFailures; attempt += 1) {
            expect(await post(undefined)).toBe(rejected);
          }
        }),
      (web) => Effect.promise(() => web.dispose()),
    ),
  );

  it.effect("answers 429 after rejected codes without touching other auth routes", () =>
    Effect.gen(function* () {
      const digest = yield* Digest.Digest;
      const context = Context.make(Digest.Digest, digest).pipe(
        Context.add(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: () => Effect.succeedNone,
            set: () => Effect.void,
            create: () => Effect.void,
            getOrCreateRandom: () => Effect.die("Not used by these routes."),
            remove: () => Effect.void,
          }),
        ),
      );
      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(layerRoutes, {
            disableLogger: true,
            middleware: (effect) =>
              Effect.updateService(effect, HttpServerRequest.HttpServerRequest, fromLoopbackSocket),
          }),
        ),
        (web) =>
          Effect.promise(async () => {
            // A malformed request is not a guess and spends no budget.
            for (let attempt = 0; attempt < 5; attempt += 1) {
              const response = await web.handler(
                tokenExchange("WRONGCODE", ATTACKER, "review:write"),
                context,
              );
              expect(response.status).toBe(400);
            }
            for (let attempt = 0; attempt < LIMITS.maxFailures; attempt += 1) {
              const response = await web.handler(
                tokenExchange(`WRONG${attempt}`, ATTACKER),
                context,
              );
              expect(response.status).toBe(401);
            }

            const locked = await web.handler(tokenExchange("ANOTHERGUESS", ATTACKER), context);
            expect(locked.status).toBe(429);
            expect(locked.headers.get("retry-after")).toBe("60");
            expect(await locked.json()).toMatchObject({ error: "too_many_requests" });

            const browser = await web.handler(
              new Request("http://127.0.0.1/api/auth/browser-session", {
                method: "POST",
                headers: { "content-type": "application/json", ...forwardedFor(ATTACKER) },
                body: JSON.stringify({ credential: "ANOTHERGUESS" }),
              }),
              context,
            );
            expect(browser.status).toBe(429);

            // The owner's own exchange over loopback is still checked, not throttled.
            const local = await web.handler(tokenExchange("ANOTHERGUESS", undefined), context);
            expect(local.status).toBe(401);

            const session = await web.handler(
              new Request("http://127.0.0.1/api/auth/session", { headers: forwardedFor(ATTACKER) }),
              context,
            );
            expect(session.status).toBe(200);
          }),
        (web) => Effect.promise(() => web.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
