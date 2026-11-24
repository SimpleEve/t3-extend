import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";

// fork: which Antigravity accounts the Usage screens can ask the server to read again.

/** One saved account, or, without `accountId`, every account of that instance that is not in use. */
export interface AccountRefreshTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly accountId?: string;
}

/** What identifies a request in flight; `all` names the whole instance. */
export function accountRefreshKey(target: AccountRefreshTarget, all = false): string {
  return `${target.environmentId}:${target.instanceId}:${all ? "*" : (target.accountId ?? "*")}`;
}

/** The account's own target, or null for the account in use, which is read live. */
export function accountRefreshTarget(account: LimitAccount): AccountRefreshTarget | null {
  return account.refresh === undefined
    ? null
    : {
        environmentId: account.refresh.environmentId,
        instanceId: account.refresh.instanceId,
        accountId: account.refresh.accountId,
      };
}

/** One whole-instance target for each instance the accounts belong to, in order of appearance. */
export function accountRefreshTargets(
  accounts: ReadonlyArray<LimitAccount>,
): ReadonlyArray<AccountRefreshTarget> {
  const targets = new Map<string, AccountRefreshTarget>();
  for (const account of accounts) {
    if (account.refresh === undefined) continue;
    const { environmentId, instanceId } = account.refresh;
    targets.set(accountRefreshKey({ environmentId, instanceId }), { environmentId, instanceId });
  }
  return [...targets.values()];
}
