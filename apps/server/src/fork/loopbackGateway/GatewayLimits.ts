// fork: the server-side limits of design 3.7: concurrent tunnels per session and in total, a
// token bucket on opening tunnels, and tickets per session per minute. Times come from the
// Effect clock, so tests move them with `TestClock`.
import { LOOPBACK_GATEWAY_LIMITS } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { refuse, type GatewayRefusal } from "./PortAuthorizer.ts";

export interface GatewayLimitsShape {
  /** Holds a tunnel slot until the scope closes; refuses at the concurrency or rate limit. */
  readonly acquireTunnel: (sessionId: string) => Effect.Effect<void, GatewayRefusal, Scope.Scope>;
  /** Counts one ticket for the session; `false` once it has had its share this minute. */
  readonly takeTicket: (sessionId: string) => Effect.Effect<boolean>;
}

interface Bucket {
  tokens: number;
  at: number;
}

export const makeGatewayLimits = (
  overrides: { readonly [K in keyof typeof LOOPBACK_GATEWAY_LIMITS]?: number } = {},
): GatewayLimitsShape => {
  const limits = { ...LOOPBACK_GATEWAY_LIMITS, ...overrides };
  const active = new Map<string, number>();
  const buckets = new Map<string, Bucket>();
  const tickets = new Map<string, Array<number>>();
  let total = 0;

  const release = (sessionId: string) =>
    Effect.sync(() => {
      total -= 1;
      const count = (active.get(sessionId) ?? 1) - 1;
      if (count <= 0) active.delete(sessionId);
      else active.set(sessionId, count);
    });

  const acquireTunnel = Effect.fn("GatewayLimits.acquireTunnel")(function* (sessionId: string) {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.acquireRelease(
      Effect.suspend(() => {
        const bucket = buckets.get(sessionId) ?? { tokens: limits.tunnelOpenBurst, at: now };
        bucket.tokens = Math.min(
          limits.tunnelOpenBurst,
          bucket.tokens + ((now - bucket.at) / 1000) * limits.tunnelOpenRefillPerSecond,
        );
        bucket.at = now;
        buckets.set(sessionId, bucket);
        if (
          total >= limits.tunnelsPerServer ||
          (active.get(sessionId) ?? 0) >= limits.tunnelsPerSession
        ) {
          return Effect.fail(refuse("limit-reached", "too many tunnels are open"));
        }
        if (bucket.tokens < 1)
          return Effect.fail(refuse("rate-limited", "tunnels are opened too quickly"));
        bucket.tokens -= 1;
        total += 1;
        active.set(sessionId, (active.get(sessionId) ?? 0) + 1);
        return Effect.void;
      }),
      () => release(sessionId),
    );
    // Idle sessions leave no bucket behind once it is full again.
    for (const [id, bucket] of buckets) {
      if (!active.has(id) && now - bucket.at > 60_000) buckets.delete(id);
    }
  });

  const takeTicket = Effect.fn("GatewayLimits.takeTicket")(function* (sessionId: string) {
    const now = yield* Clock.currentTimeMillis;
    const recent = (tickets.get(sessionId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= limits.ticketsPerSessionPerMinute) {
      tickets.set(sessionId, recent);
      return false;
    }
    recent.push(now);
    tickets.set(sessionId, recent);
    for (const [id, times] of tickets) {
      if (times.every((at) => now - at >= 60_000)) tickets.delete(id);
    }
    return true;
  });

  return { acquireTunnel, takeTicket };
};

/**
 * One limiter per process by default, so the tunnel route and the ticket RPC share it without
 * either's requirements growing a service. Tests provide a fresh one.
 */
export const GatewayLimits = Context.Reference<GatewayLimitsShape>(
  "t3/fork/loopbackGateway/GatewayLimits",
  { defaultValue: () => makeGatewayLimits() },
);
