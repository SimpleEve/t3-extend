import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { Atom } from "effect/reactivity";

import { isAtomCommandInterrupted, type AtomCommandResult } from "../../state/runtime.ts";

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

/** The input of the refresh RPC for a target. */
export function accountRefreshRequest(target: AccountRefreshTarget) {
  return {
    environmentId: target.environmentId,
    input: {
      instanceId: target.instanceId,
      ...(target.accountId === undefined ? {} : { methodId: target.accountId }),
    },
  };
}

/** A request that could not be made. A request the user walked away from is not one. */
export function accountRefreshFailed(
  result: AtomCommandResult<unknown, unknown> | undefined,
): boolean {
  return result?._tag !== "Success" && !(result !== undefined && isAtomCommandInterrupted(result));
}

/**
 * The environments, among those the targets belong to, where the session may refresh accounts, as
 * a JSON list: one environment that cannot be managed (offline, or a read-only grant) neither blocks
 * the others nor lets the button claim more than the server will allow.
 */
export const permittedRefreshEnvironmentsAtom = (
  permissionAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>,
) =>
  Atom.family((key: string) =>
    Atom.make((get) =>
      JSON.stringify((JSON.parse(key) as EnvironmentId[]).filter((id) => get(permissionAtom(id)))),
    ),
  );

/** What names a set of environments to `permittedRefreshEnvironmentsAtom`. */
export const refreshEnvironmentsKey = (targets: ReadonlyArray<AccountRefreshTarget>): string =>
  JSON.stringify([...new Set(targets.map((target) => target.environmentId))].sort());

/** The targets whose environment is in a `permittedRefreshEnvironmentsAtom` answer. */
export function permittedRefreshTargets(
  targets: ReadonlyArray<AccountRefreshTarget>,
  permitted: string,
): ReadonlyArray<AccountRefreshTarget> {
  const environments = new Set(JSON.parse(permitted) as string[]);
  return targets.filter((target) => environments.has(target.environmentId));
}
