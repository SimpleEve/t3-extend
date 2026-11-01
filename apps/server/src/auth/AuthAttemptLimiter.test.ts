import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AuthAttemptLimiter from "./AuthAttemptLimiter.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

const LIMITS: AuthAttemptLimiter.AuthAttemptLimits = {
  maxFailures: 3,
  window: Duration.minutes(1),
  lockout: Duration.seconds(60),
};

describe("AuthAttemptLimiter", () => {
  it.effect("locks after the failure budget and reopens when the lockout ends", () =>
    Effect.gen(function* () {
      const limiter = yield* AuthAttemptLimiter.make(LIMITS);
      yield* limiter.recordFailure;
      yield* limiter.recordFailure;
      expect(yield* limiter.check).toEqual({ _tag: "Allowed" });

      yield* limiter.recordFailure;
      expect(yield* limiter.check).toEqual({ _tag: "Locked", retryAfterSeconds: 60 });

      yield* TestClock.adjust(Duration.seconds(45));
      expect(yield* limiter.check).toEqual({ _tag: "Locked", retryAfterSeconds: 15 });

      yield* TestClock.adjust(Duration.seconds(15));
      expect(yield* limiter.check).toEqual({ _tag: "Allowed" });
      // The window starts fresh, so one more failure does not lock again.
      yield* limiter.recordFailure;
      expect(yield* limiter.check).toEqual({ _tag: "Allowed" });
    }),
  );

  it.effect("forgets failures older than the window", () =>
    Effect.gen(function* () {
      const limiter = yield* AuthAttemptLimiter.make(LIMITS);
      yield* limiter.recordFailure;
      yield* limiter.recordFailure;
      yield* TestClock.adjust(Duration.seconds(61));
      yield* limiter.recordFailure;
      expect(yield* limiter.check).toEqual({ _tag: "Allowed" });
    }),
  );

  it("limits only the endpoints that spend a pairing code", () => {
    expect(AuthAttemptLimiter.isLimitedAuthRequest("POST", "/oauth/token")).toBe(true);
    expect(AuthAttemptLimiter.isLimitedAuthRequest("POST", "/api/auth/browser-session")).toBe(true);
    expect(AuthAttemptLimiter.isLimitedAuthRequest("POST", "/oauth/token?x=1")).toBe(true);
    expect(AuthAttemptLimiter.isLimitedAuthRequest("GET", "/api/auth/session")).toBe(false);
    expect(AuthAttemptLimiter.isLimitedAuthRequest("POST", "/api/auth/websocket-ticket")).toBe(
      false,
    );
    expect(AuthAttemptLimiter.isLimitedAuthRequest("POST", "/oauth/mcp/token")).toBe(false);
  });
});

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-limit-test-" });
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provide(
    AuthAttemptLimiter.middleware.pipe(
      Layer.provide(
        Layer.effect(AuthAttemptLimiter.AuthAttemptLimiter, AuthAttemptLimiter.make(LIMITS)),
      ),
    ),
  ),
  Layer.provideMerge(
    EnvironmentAuth.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(layerConfig),
    ),
  ),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const tokenExchange = (subjectToken: string, scope?: string) =>
  new Request("http://127.0.0.1/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: subjectToken,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      ...(scope === undefined ? {} : { scope }),
    }),
  });

describe("AuthAttemptLimiter middleware", () => {
  it.effect("answers 429 after rejected codes without touching other auth routes", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const context = Context.make(Crypto.Crypto, crypto).pipe(
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
        Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
        (web) =>
          Effect.tryPromise(async () => {
            // A malformed request is not a guess and spends no budget.
            for (let attempt = 0; attempt < 5; attempt += 1) {
              const response = await web.handler(
                tokenExchange("WRONGCODE", "review:write"),
                context,
              );
              expect(response.status).toBe(400);
            }
            for (let attempt = 0; attempt < LIMITS.maxFailures; attempt += 1) {
              const response = await web.handler(tokenExchange(`WRONG${attempt}`), context);
              expect(response.status).toBe(401);
            }

            const locked = await web.handler(tokenExchange("ANOTHERGUESS"), context);
            expect(locked.status).toBe(429);
            expect(locked.headers.get("retry-after")).toBe("60");
            expect(await locked.json()).toMatchObject({ error: "too_many_requests" });

            const browser = await web.handler(
              new Request("http://127.0.0.1/api/auth/browser-session", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ credential: "ANOTHERGUESS" }),
              }),
              context,
            );
            expect(browser.status).toBe(429);

            const session = await web.handler(
              new Request("http://127.0.0.1/api/auth/session"),
              context,
            );
            expect(session.status).toBe(200);
          }),
        (web) => Effect.promise(() => web.dispose()),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
