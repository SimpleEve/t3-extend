import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpServerError from "effect/http/HttpServerError";

// Pairing codes carry 60 bits, are single-use, and expire in 5 minutes, so this
// only sheds noise; it does not stop brute force. Budgets are per client so a
// stranger cannot lock the machine's owner out of their own pairing and refresh.
export interface AuthAttemptLimits {
  readonly maxFailures: number;
  readonly window: Duration.Duration;
  readonly lockout: Duration.Duration;
  /** Tracked clients; the least recently failing one is dropped past this. */
  readonly maxClients: number;
}

const DEFAULT_AUTH_ATTEMPT_LIMITS: AuthAttemptLimits = {
  maxFailures: 20,
  window: Duration.minutes(1),
  lockout: Duration.seconds(60),
  maxClients: 10_000,
};

export type AuthAttemptDecision =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Locked"; readonly retryAfterSeconds: number };

export class AuthAttemptLimiter extends Context.Service<
  AuthAttemptLimiter,
  {
    readonly check: (client: string) => Effect.Effect<AuthAttemptDecision>;
    readonly recordFailure: (client: string) => Effect.Effect<void>;
  }
>()("t3/auth/AuthAttemptLimiter") {}

interface ClientState {
  /** Clock millis of failures inside the window, oldest first. */
  readonly failures: ReadonlyArray<number>;
  readonly lockedUntil: number;
}

export const make = Effect.fn("AuthAttemptLimiter.make")(function* (
  limits: AuthAttemptLimits = DEFAULT_AUTH_ATTEMPT_LIMITS,
) {
  const windowMs = Duration.toMillis(limits.window);
  const lockoutMs = Duration.toMillis(limits.lockout);
  // Insertion order is failure recency: each update re-inserts, so the first key is the oldest.
  const clients = new Map<string, ClientState>();
  const nowMs = Clock.currentTimeMillis;

  // Both run per request, inside the request's own span.
  const check = (client: string) =>
    Effect.map(nowMs, (now): AuthAttemptDecision => {
      const lockedUntil = clients.get(client)?.lockedUntil ?? 0;
      return lockedUntil > now
        ? { _tag: "Locked", retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)) }
        : { _tag: "Allowed" };
    });

  const recordFailure = Effect.fnUntraced(function* (client: string) {
    const now = yield* nowMs;
    const current = clients.get(client);
    const failures = [...(current?.failures ?? []).filter((at) => at > now - windowMs), now];
    // A fresh window after each lockout, so the first failure after it cannot re-lock.
    const locked = failures.length >= limits.maxFailures;
    clients.delete(client);
    clients.set(
      client,
      locked
        ? { failures: [], lockedUntil: now + lockoutMs }
        : { failures, lockedUntil: current?.lockedUntil ?? 0 },
    );
    for (const oldest of clients.keys()) {
      if (clients.size <= limits.maxClients) break;
      clients.delete(oldest);
    }
    if (locked) {
      yield* Effect.logWarning("authentication attempts locked after repeated failures", {
        client,
        maxFailures: limits.maxFailures,
        lockoutSeconds: lockoutMs / 1000,
      });
    }
  });

  return AuthAttemptLimiter.of({ check, recordFailure });
});

export const layer = Layer.effect(AuthAttemptLimiter, make());

/**
 * The response status that means a pairing code was rejected, for the endpoints
 * that spend one; `undefined` leaves the request alone. The MCP approval page
 * reports every refusal, including a wrong code, as 400.
 */
export const rejectedCodeStatus = (method: string, url: string): number | undefined => {
  if (method !== "POST") return undefined;
  switch (url.split("?", 1)[0]) {
    case "/oauth/token":
    case "/api/auth/browser-session":
      return 401;
    case "/oauth/mcp/decision":
      return 400;
    default:
      return undefined;
  }
};

const isLoopbackAddress = (address: string) => {
  const host = address.replace(/^::ffff:/i, "");
  return host === "::1" || host.startsWith("127.");
};

/**
 * The bucket a request's failures count against, or `null` for this machine's
 * own direct calls (desktop bootstrap, local CLI). Proxies such as Caddy and
 * Tailscale Serve append the peer they saw to `X-Forwarded-For`, so its last
 * entry is the one hop a client cannot forge from outside.
 */
export const clientKey = (input: {
  readonly remoteAddress: string | undefined;
  readonly forwardedFor: string | undefined;
}): string | null => {
  const forwarded = input.forwardedFor
    ?.split(",")
    .map((entry) => entry.trim())
    .findLast((entry) => entry.length > 0);
  if (forwarded !== undefined) return `forwarded:${forwarded}`;
  if (input.remoteAddress !== undefined && isLoopbackAddress(input.remoteAddress)) return null;
  return `socket:${input.remoteAddress ?? "unknown"}`;
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

export const middleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const limiter = yield* AuthAttemptLimiter;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const rejectedStatus = rejectedCodeStatus(request.method, request.url);
        if (rejectedStatus === undefined) return yield* httpEffect;
        const client = clientKey({
          remoteAddress: Option.getOrUndefined(request.remoteAddress),
          forwardedFor: request.headers["x-forwarded-for"],
        });
        if (client === null) return yield* httpEffect;
        const decision = yield* limiter.check(client);
        if (decision._tag === "Locked") return tooManyAttemptsResponse(decision.retryAfterSeconds);
        const exit = yield* Effect.exit(httpEffect);
        const status = Exit.isSuccess(exit)
          ? exit.value.status
          : (yield* HttpServerError.causeResponse(exit.cause))[0].status;
        if (status === rejectedStatus) yield* limiter.recordFailure(client);
        return yield* exit;
      });
  }),
  { global: true },
);
