// The allowed-ports list as the authorizer's tests need it: a set the test changes between calls.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { LoopbackGatewayGrants } from "./LoopbackGatewayGrants.ts";

export const memoryGrants = (ports: Set<number> = new Set()) => {
  const entries = () => [...ports].map((port) => ({ port, allowedAt: DateTime.makeUnsafe(0) }));
  const state = Effect.runSync(SubscriptionRef.make(entries()));
  const publish = Effect.suspend(() => SubscriptionRef.set(state, entries()));
  return LoopbackGatewayGrants.of({
    list: Effect.sync(entries),
    changes: SubscriptionRef.changes(state),
    allow: (port) =>
      Effect.sync(() => void ports.add(port)).pipe(
        Effect.andThen(publish),
        Effect.andThen(Effect.sync(entries)),
      ),
    remove: (port) =>
      Effect.sync(() => void ports.delete(port)).pipe(
        Effect.andThen(publish),
        Effect.andThen(Effect.sync(entries)),
      ),
  });
};
