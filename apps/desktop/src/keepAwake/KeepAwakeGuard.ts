export interface KeepAwakeBlocker {
  /** Returns the id to pass to `stop`. */
  readonly start: () => number;
  readonly stop: (id: number) => void;
}

/**
 * Holds one blocker while any renderer says a thread is running. Each renderer's last report is
 * all that counts, and a renderer that is gone, reloading, or navigating away reports nothing, so
 * it counts as not running.
 */
export function makeKeepAwakeGuard(blocker: KeepAwakeBlocker) {
  const active = new Set<number>();
  let held: number | null = null;

  const sync = () => {
    if (active.size > 0 && held === null) held = blocker.start();
    if (active.size === 0 && held !== null) {
      blocker.stop(held);
      held = null;
    }
  };

  return {
    report(rendererId: number, running: boolean) {
      if (running) active.add(rendererId);
      else active.delete(rendererId);
      sync();
    },
    drop(rendererId: number) {
      active.delete(rendererId);
      sync();
    },
    releaseAll() {
      active.clear();
      sync();
    },
    isHeld: () => held !== null,
  };
}
