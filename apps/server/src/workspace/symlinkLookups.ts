// @effect-diagnostics globalTimers:off
// A lookup that hangs outlives the request that started it, so its slot cannot be tied to a fiber.

/** The lookup timed out, or never got a turn. Nothing is known about the target. */
export const SYMLINK_UNRESOLVED = Symbol("SYMLINK_UNRESOLVED");

/**
 * Following a link can hang on an unresponsive mount, and a hung call cannot be cancelled: it keeps
 * a libuv worker (4 by default) until the OS gives up. So only a few lookups run at once, shared by
 * every caller, and a slot stays taken until its call really returns.
 */
export function makeSymlinkLookups(options: {
  readonly maxPending: number;
  readonly timeoutMs: number;
}) {
  let running = 0;
  // Running lookups past their timeout. When every slot holds one, waiting is pointless.
  let stalled = 0;
  const waiting = new Set<{ readonly start: () => void; readonly giveUp: () => void }>();

  /** `maxWaitMs` bounds the wait for a free slot; `timeoutMs` then bounds the lookup itself. */
  return <A>(run: () => Promise<A>, maxWaitMs: number) =>
    new Promise<A | typeof SYMLINK_UNRESOLVED>((resolve, reject) => {
      const start = () => {
        running++;
        let isStalled = false;
        const timer = setTimeout(() => {
          isStalled = true;
          stalled++;
          resolve(SYMLINK_UNRESOLVED);
          if (stalled === options.maxPending) for (const waiter of waiting) waiter.giveUp();
        }, options.timeoutMs);
        run()
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timer);
            if (isStalled) stalled--;
            running--;
            waiting.values().next().value?.start();
          });
      };
      if (running < options.maxPending) return start();
      if (stalled === options.maxPending || maxWaitMs <= 0) return resolve(SYMLINK_UNRESOLVED);
      const leave = () => {
        waiting.delete(waiter);
        clearTimeout(waitTimer);
      };
      const waiter = {
        start: () => {
          leave();
          start();
        },
        giveUp: () => {
          leave();
          resolve(SYMLINK_UNRESOLVED);
        },
      };
      const waitTimer = setTimeout(waiter.giveUp, maxWaitMs);
      waiting.add(waiter);
    });
}
