import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeSymlinkLookups, SYMLINK_UNRESOLVED } from "./symlinkLookups.ts";

const TIMEOUT_MS = 1_000;

// A lookup the test settles by hand, as a stuck call only returns when the OS gives up.
const manualLookup = <A>(started?: () => void) => {
  const settled = Promise.withResolvers<A>();
  return {
    run: () => {
      started?.();
      return settled.promise;
    },
    resolve: settled.resolve,
  };
};

describe("makeSymlinkLookups", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts waiting lookups in the order they arrived", async () => {
    const lookUp = makeSymlinkLookups({ maxPending: 1, timeoutMs: TIMEOUT_MS });
    const order: Array<string> = [];
    const first = manualLookup<string>(() => order.push("first"));
    const second = manualLookup<string>(() => order.push("second"));
    const third = manualLookup<string>(() => order.push("third"));
    const results = [first, second, third].map((lookup) => lookUp(lookup.run, 5_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["first"]);
    first.resolve("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["first", "second"]);
    second.resolve("b");
    await vi.advanceTimersByTimeAsync(0);
    third.resolve("c");
    expect(await Promise.all(results)).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("gives up on a lookup that waited too long for a slot, without starting it", async () => {
    const lookUp = makeSymlinkLookups({ maxPending: 1, timeoutMs: 10_000 });
    const held = manualLookup<string>();
    const heldResult = lookUp(held.run, 0);
    const started = vi.fn();
    const late = manualLookup<string>(started);
    const lateResult = lookUp(late.run, 200);
    await vi.advanceTimersByTimeAsync(199);
    held.resolve("held");
    // The slot frees up before the deadline, so the waiter starts instead of timing out.
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledOnce();
    late.resolve("late");
    expect(await Promise.all([heldResult, lateResult])).toEqual(["held", "late"]);

    const stuck = manualLookup<string>();
    void lookUp(stuck.run, 0);
    const skipped = vi.fn();
    const skippedResult = lookUp(manualLookup<string>(skipped).run, 200);
    await vi.advanceTimersByTimeAsync(200);
    expect(await skippedResult).toBe(SYMLINK_UNRESOLVED);
    stuck.resolve("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(skipped).not.toHaveBeenCalled();
  });

  it("answers at once when every slot holds a lookup past its timeout", async () => {
    const onStalled = vi.fn();
    const lookUp = makeSymlinkLookups({ maxPending: 2, timeoutMs: TIMEOUT_MS, onStalled });
    const stuck = [manualLookup<string>(), manualLookup<string>()];
    const stuckResults = stuck.map((lookup) => lookUp(lookup.run, 5_000));
    const queued = vi.fn();
    const queuedResult = lookUp(manualLookup<string>(queued).run, 5_000);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(onStalled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all([...stuckResults, queuedResult])).toEqual([
      SYMLINK_UNRESOLVED,
      SYMLINK_UNRESOLVED,
      SYMLINK_UNRESOLVED,
    ]);
    expect(onStalled).toHaveBeenCalledOnce();
    // Nothing waits for the full budget now, and nothing new starts.
    const started = vi.fn();
    expect(await lookUp(manualLookup<string>(started).run, 5_000)).toBe(SYMLINK_UNRESOLVED);
    expect(started).not.toHaveBeenCalled();

    // One stuck call returns: lookups run again, and a later stall is reported again.
    stuck[0]!.resolve("back");
    await vi.advanceTimersByTimeAsync(0);
    const next = manualLookup<string>();
    const nextResult = lookUp(next.run, 5_000);
    await vi.advanceTimersByTimeAsync(0);
    next.resolve("ok");
    expect(await nextResult).toBe("ok");
    const stuckAgain = manualLookup<string>();
    const stuckAgainResult = lookUp(stuckAgain.run, 5_000);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(await stuckAgainResult).toBe(SYMLINK_UNRESOLVED);
    expect(onStalled).toHaveBeenCalledTimes(2);
  });

  it("does not keep a slot when the lookup throws before returning a promise", async () => {
    const lookUp = makeSymlinkLookups({ maxPending: 1, timeoutMs: TIMEOUT_MS });
    const boom = new Error("boom");
    await expect(
      lookUp(() => {
        throw boom;
      }, 0),
    ).rejects.toBe(boom);
    const next = manualLookup<string>();
    const nextResult = lookUp(next.run, 0);
    next.resolve("ok");
    expect(await nextResult).toBe("ok");
  });

  effectIt.effect(
    "hands the slot back once the call returns, even if its caller was interrupted",
    () =>
      Effect.gen(function* () {
        const lookUp = makeSymlinkLookups({ maxPending: 1, timeoutMs: 10_000 });
        const advance = (ms: number) => Effect.promise(() => vi.advanceTimersByTimeAsync(ms));
        const abandoned = manualLookup<string>();
        const fiber = yield* Effect.forkChild(Effect.promise(() => lookUp(abandoned.run, 0)));
        yield* advance(0);
        yield* Fiber.interrupt(fiber);
        // The call cannot be cancelled, so the slot is still taken...
        const started = vi.fn();
        const next = manualLookup<string>(started);
        const nextResult = lookUp(next.run, 5_000);
        yield* advance(0);
        expect(started).not.toHaveBeenCalled();
        // ...until it returns.
        abandoned.resolve("late");
        yield* advance(0);
        expect(started).toHaveBeenCalledOnce();
        next.resolve("ok");
        expect(yield* Effect.promise(() => nextResult)).toBe("ok");
      }),
  );
});
