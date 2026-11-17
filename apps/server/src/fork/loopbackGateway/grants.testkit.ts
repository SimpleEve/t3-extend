// The allowed-ports list as the authorizer's tests need it: a set the test changes between calls.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { LoopbackGatewayGrants } from "./LoopbackGatewayGrants.ts";

export const memoryGrants = (ports: Set<number> = new Set()) => {
  const list = Effect.sync(() =>
    [...ports].map((port) => ({ port, allowedAt: DateTime.makeUnsafe(0) })),
  );
  return LoopbackGatewayGrants.of({
    list,
    allow: (port) => Effect.sync(() => void ports.add(port)).pipe(Effect.andThen(list)),
    remove: (port) => Effect.sync(() => void ports.delete(port)).pipe(Effect.andThen(list)),
  });
};
