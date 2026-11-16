import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

// fork: instances that share the agy CLI login share one answer to "is it signed in", so several
// of them starting together open one agent, not one each. Module scope because drivers are rebuilt
// with their settings, while the executable and the keyring they ask about stay the same.
export type SharedLoginOutcome = "signed-in" | "sign-in-required" | "unknown";

/**
 * One check may take as long as a model refresh: on Windows the agent unpacks for about a minute
 * before it answers. Leaving the scope on the timeout stops the agent.
 */
export const SHARED_LOGIN_CHECK_TIMEOUT_MS = 90_000;

/** A recent answer is reused so instances that start a moment apart still share one check. */
export const SHARED_LOGIN_REUSE_MS = 60_000;

interface Entry {
  readonly pending?: Deferred.Deferred<SharedLoginOutcome>;
  readonly answered?: { readonly outcome: SharedLoginOutcome; readonly at: number };
}

const entries = new Map<string, Entry>();

/** `key` names what is asked, such as the agent executable. `check` never fails; a doubt is `unknown`. */
export const runSharedLoginCheck = Effect.fn("runSharedLoginCheck")(function* (
  key: string,
  check: Effect.Effect<SharedLoginOutcome>,
) {
  const now = yield* Clock.currentTimeMillis;
  const entry = entries.get(key);
  if (entry?.pending) return yield* Deferred.await(entry.pending);
  if (
    entry?.answered &&
    entry.answered.outcome !== "unknown" &&
    now - entry.answered.at < SHARED_LOGIN_REUSE_MS
  ) {
    return entry.answered.outcome;
  }
  const pending = yield* Deferred.make<SharedLoginOutcome>();
  entries.set(key, { ...(entry?.answered ? { answered: entry.answered } : {}), pending });
  return yield* check.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        // An interrupted check answers `unknown`, so the instances waiting on it are never stuck.
        const outcome = Exit.isSuccess(exit) ? exit.value : "unknown";
        entries.set(key, { answered: { outcome, at: yield* Clock.currentTimeMillis } });
        yield* Deferred.succeed(pending, outcome);
      }),
    ),
  );
});
