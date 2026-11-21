import type { OrchestrationV2ProviderFailure, ServerProviderAccount } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { AntigravityAccountPool } from "./antigravityAccountPool.ts";

// fork: what a thread says when a usage limit moves it to another saved account.

/** `someone@example.com` as `s•••@example.com`: enough to tell accounts apart in a shared thread. */
export function maskAntigravityEmail(email: string | null): string {
  if (email === null) return "another account";
  const at = email.lastIndexOf("@");
  if (at < 1) return "another account";
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

function resetLabel(epochMillis: number): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(epochMillis);
}

/** The accounts as a provider snapshot lists them; an instance with none lists nothing. */
export const antigravityServerAccounts = (pool: Pick<AntigravityAccountPool, "list">) =>
  pool.list.pipe(
    Effect.map((accounts): ReadonlyArray<ServerProviderAccount> =>
      accounts.map((account) => ({
        id: account.id,
        ...(account.email === null ? {} : { email: account.email }),
        current: account.current,
        ...(account.exhaustedUntil === null
          ? {}
          : { exhaustedUntil: DateTime.formatIso(DateTime.makeUnsafe(account.exhaustedUntil)) }),
      })),
    ),
  );

/**
 * Called when a turn ends on a usage limit. Records the spent account, then either names the account
 * that takes over (the agent restarts on it and the turn goes on), or says every account is spent.
 */
export const makeAntigravityUsageLimitRecovery =
  (pool: Pick<AntigravityAccountPool, "markExhausted" | "list">) =>
  (failure: OrchestrationV2ProviderFailure) =>
    Effect.gen(function* () {
      const parsed = failure.resetAt ? Date.parse(failure.resetAt) : Number.NaN;
      const plan = yield* pool.markExhausted(Number.isFinite(parsed) ? parsed : undefined);
      if (plan._tag === "Rotate") {
        return {
          notice: `${maskAntigravityEmail(plan.from.email)} used its Antigravity quota (resets ${resetLabel(plan.from.resetAt)}). Switched to ${maskAntigravityEmail(plan.to.email)} and continued this turn.`,
        };
      }
      // With one account there is nobody to switch to, so the plain usage-limit failure stands.
      if (plan._tag === "AllExhausted" && (yield* pool.list).length > 1) {
        return {
          failure: makeProviderFailure({
            class: "usage_limit",
            message: `Every saved Antigravity account has used its quota. The first one resets ${resetLabel(plan.earliestResetAt)}.`,
            code: failure.code,
            retryable: true,
            resetAt: DateTime.formatIso(DateTime.makeUnsafe(plan.earliestResetAt)),
          }),
        };
      }
      return undefined;
    });
