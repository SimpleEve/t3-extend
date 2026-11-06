// The server-side limits of design 3.7 on the Effect clock: no real time passes.
import { assert, describe, it } from "@effect/vitest";
import { LOOPBACK_GATEWAY_LIMITS } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makeGatewayLimits } from "./GatewayLimits.ts";

describe("tunnel limits", () => {
  it.effect("holds a session to 64 concurrent tunnels and frees a slot when one closes", () =>
    Effect.gen(function* () {
      const limits = makeGatewayLimits();
      const scopes: Array<Scope.Closeable> = [];
      const open = Effect.gen(function* () {
        const scope = yield* Scope.make();
        scopes.push(scope);
        return yield* limits.acquireTunnel("s1").pipe(Scope.provide(scope));
      });
      // The bucket holds 60; one second adds 30 more, so 64 can be reached.
      for (let i = 0; i < 60; i++) yield* open;
      yield* TestClock.adjust(Duration.seconds(1));
      for (let i = 0; i < 4; i++) yield* open;
      assert.equal(scopes.length, 64);
      const extra = yield* Scope.make();
      const error = yield* limits.acquireTunnel("s1").pipe(Scope.provide(extra), Effect.flip);
      assert.equal(error.code, "limit-reached");
      yield* Scope.close(scopes[0]!, Exit.void);
      yield* limits.acquireTunnel("s1").pipe(Scope.provide(extra));
      // Another session is unaffected.
      yield* limits.acquireTunnel("s2").pipe(Scope.provide(extra));
    }).pipe(Effect.scoped),
  );

  it.effect("holds the server to 256 concurrent tunnels across sessions", () =>
    Effect.gen(function* () {
      const limits = makeGatewayLimits();
      const scope = yield* Scope.make();
      for (let session = 0; session < 64; session++) {
        for (let i = 0; i < 4; i++)
          yield* limits.acquireTunnel(`s${session}`).pipe(Scope.provide(scope));
      }
      const error = yield* limits.acquireTunnel("fresh").pipe(Scope.provide(scope), Effect.flip);
      assert.equal(error.code, "limit-reached");
      yield* Scope.close(scope, Exit.void);
      yield* limits.acquireTunnel("fresh").pipe(Scope.provide(yield* Scope.make()));
    }),
  );

  it.effect(
    "limits opening to a burst of 60 refilled at 30 a second, however quickly tunnels close",
    () =>
      Effect.gen(function* () {
        const limits = makeGatewayLimits();
        const openAndClose = Effect.scoped(limits.acquireTunnel("s1"));
        for (let i = 0; i < LOOPBACK_GATEWAY_LIMITS.tunnelOpenBurst; i++) yield* openAndClose;
        assert.equal((yield* openAndClose.pipe(Effect.flip)).code, "rate-limited");
        yield* TestClock.adjust(Duration.seconds(1));
        for (let i = 0; i < LOOPBACK_GATEWAY_LIMITS.tunnelOpenRefillPerSecond; i++)
          yield* openAndClose;
        assert.equal((yield* openAndClose.pipe(Effect.flip)).code, "rate-limited");
        // A refused attempt does not spend a token or hold a slot.
        yield* TestClock.adjust(Duration.millis(40));
        yield* openAndClose;
      }),
  );

  it.effect("gives a session 30 tickets a minute", () =>
    Effect.gen(function* () {
      const limits = makeGatewayLimits();
      for (let i = 0; i < 30; i++) assert.isTrue(yield* limits.takeTicket("s1"));
      assert.isFalse(yield* limits.takeTicket("s1"));
      assert.isTrue(yield* limits.takeTicket("s2"));
      yield* TestClock.adjust(Duration.seconds(60));
      assert.isTrue(yield* limits.takeTicket("s1"));
    }),
  );

  it.effect("takes the numbers of design 3.7", () =>
    Effect.sync(() => {
      assert.equal(LOOPBACK_GATEWAY_LIMITS.tunnelsPerSession, 64);
      assert.equal(LOOPBACK_GATEWAY_LIMITS.tunnelsPerServer, 256);
      assert.equal(LOOPBACK_GATEWAY_LIMITS.ticketsPerSessionPerMinute, 30);
    }),
  );
});
