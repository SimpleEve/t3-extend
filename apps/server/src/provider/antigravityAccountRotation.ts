import type {
  OrchestrationV2ProviderFailure,
  ServerProviderAccount,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
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

/**
 * The accounts as a provider snapshot lists them; an instance with none lists nothing. Without
 * `readUsageLimits` no reading, refresh or read failure is listed, even from an earlier time the
 * setting was on: the instance then shows no quota, as one that cannot read it does.
 */
export const antigravityServerAccounts = (
  pool: Pick<AntigravityAccountPool, "list">,
  options: { readonly readUsageLimits: boolean },
) =>
  pool.list.pipe(
    Effect.map((accounts): ReadonlyArray<ServerProviderAccount> =>
      accounts.map((account) => ({
        id: account.id,
        ...(account.email === null ? {} : { email: account.email }),
        current: account.current,
        ...(account.exhaustedUntil === null
          ? {}
          : { exhaustedUntil: DateTime.formatIso(DateTime.makeUnsafe(account.exhaustedUntil)) }),
        // The account in use is read live; every other one can be read on request.
        ...(account.current || !options.readUsageLimits ? {} : { refreshable: true }),
        ...(account.usageLimits === null || !options.readUsageLimits
          ? {}
          : { usageLimits: account.usageLimits }),
        ...(account.probe.failure === null || !options.readUsageLimits
          ? {}
          : {
              usageProbeFailure: {
                at: DateTime.formatIso(DateTime.makeUnsafe(account.probe.failure.at)),
                reason: account.probe.failure.reason,
              },
            }),
      })),
    ),
  );

/**
 * The current account's remembered reading is the live one that `provider.usageLimits` already
 * carries, so while that stands in for it the copy stays off the wire. It stays on when there is no
 * usable live reading, or the live reading names another account: the client then shows it instead.
 */
export const withoutLiveReadingCopy = (
  accounts: ReadonlyArray<ServerProviderAccount>,
  live: ServerProviderUsageLimits | undefined,
): ReadonlyArray<ServerProviderAccount> => {
  if (live === undefined || live.unavailable !== undefined || live.windows.length === 0) {
    return accounts;
  }
  return accounts.map((account) => {
    const remembered = account.usageLimits?.credentialFingerprint;
    const sameAccount =
      remembered === undefined ||
      live.credentialFingerprint === undefined ||
      remembered === live.credentialFingerprint;
    if (!account.current || account.usageLimits === undefined || !sameAccount) return account;
    const { usageLimits: _copy, ...rest } = account;
    return rest;
  });
};

/**
 * Called when a turn ends on a usage limit. Records the spent account, then either names the account
 * that takes over (the agent restarts on it and the turn goes on), or says every account is spent.
 */
export const makeAntigravityUsageLimitRecovery =
  (pool: Pick<AntigravityAccountPool, "markExhausted" | "list">) =>
  (failure: OrchestrationV2ProviderFailure, turn?: { readonly promptSentAt: number | null }) =>
    Effect.gen(function* () {
      const parsed = failure.resetAt ? Date.parse(failure.resetAt) : Number.NaN;
      const plan = yield* pool.markExhausted(
        Number.isFinite(parsed) ? parsed : undefined,
        turn?.promptSentAt ?? undefined,
      );
      if (plan._tag === "Moved") {
        return {
          notice: `This Antigravity instance had already switched to ${maskAntigravityEmail(plan.to.email)} after a usage limit. Continued this turn on it.`,
        };
      }
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
