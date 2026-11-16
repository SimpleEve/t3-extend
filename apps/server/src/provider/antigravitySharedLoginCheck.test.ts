import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  runSharedLoginCheck,
  SHARED_LOGIN_CHECK_TIMEOUT_MS,
  SHARED_LOGIN_REUSE_MS,
  type SharedLoginOutcome,
} from "./antigravitySharedLoginCheck.ts";

const countedCheck = (outcome: SharedLoginOutcome) =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const release = yield* Deferred.make<void>();
    const check = Ref.update(starts, (count) => count + 1).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.as(outcome),
    );
    return { starts, release, check };
  });

// fork: every key is its own executable, so tests never see each other's answers.
let keyCounter = 0;
const freshKey = () => `/test/agy-${keyCounter++}`;

it.effect("instances that start together share one check", () =>
  Effect.gen(function* () {
    const key = freshKey();
    const { starts, release, check } = yield* countedCheck("signed-in");
    const first = yield* Effect.forkChild(runSharedLoginCheck(key, check));
    const second = yield* Effect.forkChild(runSharedLoginCheck(key, check));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toBe("signed-in");
    expect(yield* Fiber.join(second)).toBe("signed-in");
    expect(yield* Ref.get(starts)).toBe(1);
  }),
);

it.effect("reuses a recent answer, then asks again, and never trusts an unknown one", () =>
  Effect.gen(function* () {
    const key = freshKey();
    const { starts, release, check } = yield* countedCheck("sign-in-required");
    yield* Deferred.succeed(release, undefined);
    expect(yield* runSharedLoginCheck(key, check)).toBe("sign-in-required");
    expect(yield* runSharedLoginCheck(key, check)).toBe("sign-in-required");
    expect(yield* Ref.get(starts)).toBe(1);
    yield* TestClock.adjust(SHARED_LOGIN_REUSE_MS);
    yield* runSharedLoginCheck(key, check);
    expect(yield* Ref.get(starts)).toBe(2);

    const unknownKey = freshKey();
    const unknown = yield* countedCheck("unknown");
    yield* Deferred.succeed(unknown.release, undefined);
    yield* runSharedLoginCheck(unknownKey, unknown.check);
    yield* runSharedLoginCheck(unknownKey, unknown.check);
    expect(yield* Ref.get(unknown.starts)).toBe(2);
  }),
);

it.effect("different executables are checked separately", () =>
  Effect.gen(function* () {
    const { starts, release, check } = yield* countedCheck("signed-in");
    yield* Deferred.succeed(release, undefined);
    yield* runSharedLoginCheck(freshKey(), check);
    yield* runSharedLoginCheck(freshKey(), check);
    expect(yield* Ref.get(starts)).toBe(2);
  }),
);

it.effect("an interrupted check frees the instances waiting on it", () =>
  Effect.gen(function* () {
    const key = freshKey();
    const { check } = yield* countedCheck("signed-in");
    const owner = yield* Effect.forkChild(runSharedLoginCheck(key, check));
    yield* Effect.yieldNow;
    const waiter = yield* Effect.forkChild(runSharedLoginCheck(key, check));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(owner);
    expect(yield* Fiber.join(waiter)).toBe("unknown");
  }),
);

// fork: Windows needs about a minute to unpack the agent (see AntigravityAuth), so the budget matches a model refresh.
it("allows a check as long as a model refresh", () => {
  expect(SHARED_LOGIN_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
});
