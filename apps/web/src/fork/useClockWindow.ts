// fork: re-renders a view exactly when a time-derived label changes, with one timeout to the next
// change and no interval, as hooks/useRelativeTimeState.ts does for relative times. Formatting
// inline in render is cached by the compiler on its inputs, so it would go stale on an idle page.
import { useSyncExternalStore } from "react";

/** The stretch of time over which a derived label reads the same. `endMs` is null for a label that never changes. */
export interface ClockWindow {
  readonly startMs: number;
  readonly endMs: number | null;
}

// setTimeout fires immediately for delays above 2^31-1, so a long wait is split into days.
const MAX_DELAY_MS = 86_400_000;

/**
 * Returns the start of the window `now` falls in. Compute the label from that value, not from the
 * clock: it only changes when the label does.
 */
export function useClockWindowStart(windowAt: (nowMs: number) => ClockWindow): number {
  const subscribe = (onChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const { endMs } = windowAt(Date.now());
      if (endMs === null) return;
      timer = setTimeout(
        () => {
          onChange();
          schedule();
        },
        Math.min(Math.max(endMs - Date.now(), 1), MAX_DELAY_MS),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  };
  const getSnapshot = () => windowAt(Date.now()).startMs;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
