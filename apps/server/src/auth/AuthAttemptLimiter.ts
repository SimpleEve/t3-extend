import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpServerError from "effect/http/HttpServerError";

/**
 * Throttles guessing of one-time pairing codes once the server is reachable
 * from the internet. A reverse tunnel (frpc, Tailscale Serve, T3 Connect)
 * delivers every request from loopback, so the budget is global rather than
 * per address: an attacker can delay new pairings, never guess faster.
 */
export interface AuthAttemptLimits {
  readonly maxFailures: number;
  readonly window: Duration.Duration;
  readonly lockout: Duration.Duration;
}

const DEFAULT_AUTH_ATTEMPT_LIMITS: AuthAttemptLimits = {
  maxFailures: 20,
  window: Duration.minutes(1),
  lockout: Duration.seconds(60),
};

export type AuthAttemptDecision =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Locked"; readonly retryAfterSeconds: number };

export class AuthAttemptLimiter extends Context.Service<
  AuthAttemptLimiter,
  {
    readonly check: Effect.Effect<AuthAttemptDecision>;
    readonly recordFailure: Effect.Effect<void>;
  }
>()("t3/auth/AuthAttemptLimiter") {}

interface LimiterState {
  /** Clock millis of failures inside the window, oldest first. */
  readonly failures: ReadonlyArray<number>;
  readonly lockedUntil: number;
}

export const make = Effect.fn("AuthAttemptLimiter.make")(function* (
  limits: AuthAttemptLimits = DEFAULT_AUTH_ATTEMPT_LIMITS,
) {
  const windowMs = Duration.toMillis(limits.window);
  const lockoutMs = Duration.toMillis(limits.lockout);
  const state = yield* Ref.make<LimiterState>({ failures: [], lockedUntil: 0 });
  const nowMs = Clock.currentTimeMillis;

  // Both run per request, inside the request's own span.
  const check = Effect.gen(function* () {
    const now = yield* nowMs;
    const { lockedUntil } = yield* Ref.get(state);
    return lockedUntil > now
      ? ({
          _tag: "Locked",
          retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)),
        } as const)
      : ({ _tag: "Allowed" } as const);
  });

  const recordFailure = Effect.gen(function* () {
    const now = yield* nowMs;
    const locked = yield* Ref.modify(state, (current): [boolean, LimiterState] => {
      const failures = [...current.failures.filter((at) => at > now - windowMs), now];
      // A fresh window after each lockout, so the first failure after it cannot re-lock.
      return failures.length >= limits.maxFailures
        ? [true, { failures: [], lockedUntil: now + lockoutMs }]
        : [false, { failures, lockedUntil: current.lockedUntil }];
    });
    if (locked) {
      yield* Effect.logWarning("authentication attempts locked after repeated failures", {
        maxFailures: limits.maxFailures,
        lockoutSeconds: lockoutMs / 1000,
      });
    }
  });

  return AuthAttemptLimiter.of({ check, recordFailure });
});

export const layer = Layer.effect(AuthAttemptLimiter, make());

/** Endpoints that spend a pairing code. Session refreshes and authenticated calls are untouched. */
export const isLimitedAuthRequest = (method: string, url: string): boolean => {
  if (method !== "POST") return false;
  const path = url.split("?", 1)[0];
  return path === "/oauth/token" || path === "/api/auth/browser-session";
};

const tooManyAttemptsResponse = (retryAfterSeconds: number) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "too_many_requests",
      error_description: "Too many failed sign-in attempts. Try again shortly.",
    },
    {
      status: 429,
      headers: { "retry-after": String(retryAfterSeconds), "cache-control": "no-store" },
    },
  );

/** A rejected credential, not a malformed request or a server fault. */
const isRejectedCredential = (status: number) => status === 401;

export const middleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const limiter = yield* AuthAttemptLimiter;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!isLimitedAuthRequest(request.method, request.url)) return yield* httpEffect;
        const decision = yield* limiter.check;
        if (decision._tag === "Locked") return tooManyAttemptsResponse(decision.retryAfterSeconds);
        const exit = yield* Effect.exit(httpEffect);
        const status = Exit.isSuccess(exit)
          ? exit.value.status
          : (yield* HttpServerError.causeResponse(exit.cause))[0].status;
        if (isRejectedCredential(status)) yield* limiter.recordFailure;
        return yield* exit;
      });
  }),
  { global: true },
);
