// fork: composer context meter
import { useAtomValue } from "@effect/atom-react";
import type { ContextMeter } from "@t3tools/client-runtime/state/context-window";
import type { TurnSpeed } from "@t3tools/client-runtime/state/turn-speed";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "./threads";

const EMPTY_CONTEXT_RING_ATOM = Atom.make<Pick<ContextMeter, "percent" | "tone"> | null>(null).pipe(
  Atom.withLabel("mobile-thread-context-ring:empty"),
);
const EMPTY_CONTEXT_METER_ATOM = Atom.make<ContextMeter | null>(null).pipe(
  Atom.withLabel("mobile-thread-context-meter:empty"),
);
const EMPTY_LAST_TURN_SPEED_ATOM = Atom.make<TurnSpeed | null>(null).pipe(
  Atom.withLabel("mobile-thread-last-turn-speed:empty"),
);

/** The rounded percentage and tone only; it holds still while the token counts move. */
export function useThreadContextRing(ref: ScopedThreadRef | null) {
  return useAtomValue(
    ref === null ? EMPTY_CONTEXT_RING_ATOM : environmentThreadDetails.contextRingAtom(ref),
  );
}

export function useThreadContextMeter(ref: ScopedThreadRef | null) {
  return useAtomValue(
    ref === null ? EMPTY_CONTEXT_METER_ATOM : environmentThreadDetails.contextMeterAtom(ref),
  );
}

export function useThreadLastTurnSpeed(ref: ScopedThreadRef | null) {
  return useAtomValue(
    ref === null ? EMPTY_LAST_TURN_SPEED_ATOM : environmentThreadDetails.lastTurnSpeedAtom(ref),
  );
}
