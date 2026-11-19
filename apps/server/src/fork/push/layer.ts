import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PushApns from "./PushApns.ts"; // fork: iOS
import * as PushNotifier from "./PushNotifier.ts";
import * as PushRegistrations from "./PushRegistrations.ts";

/** Provides both push services and starts watching threads. */
export const layer = Layer.effectDiscard(
  PushNotifier.PushNotifier.pipe(Effect.flatMap((notifier) => notifier.start())),
).pipe(
  Layer.provideMerge(PushNotifier.layer),
  Layer.provideMerge(PushRegistrations.layer),
  Layer.provideMerge(PushApns.layer),
);
