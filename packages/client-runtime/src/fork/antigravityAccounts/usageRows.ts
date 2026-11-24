import {
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
} from "@t3tools/shared/usageLimits";

// fork: one row per Google account of an Antigravity pool, as the Usage screens list them.

export interface AccountUsageColumn {
  readonly id: string;
  readonly kind: LimitPoolMember["window"]["kind"];
  readonly label: string;
}

export interface AccountUsageRow {
  readonly account: LimitAccount;
  readonly current: boolean;
  /** Milliseconds since the reading was taken; null while it is live or when there is none. */
  readonly readAgoMs: number | null;
  /** The account has not been in use since it was saved, so there is nothing to show. */
  readonly unread: boolean;
  /** Epoch milliseconds until which the account's quota is spent; null while it has quota. */
  readonly exhaustedUntil: number | null;
  /** One per column, in column order; null where the account reports no such window. */
  readonly cells: ReadonlyArray<LimitPoolMember | null>;
}

/** The compact list is for an Antigravity pool with several accounts; others keep the segment bars. */
export function listsAccountUsage(pool: LimitPool): boolean {
  return pool.driver === "antigravity" && pool.accounts.length > 1;
}

/** The account in use first, then the rest by whose quota comes back soonest. */
export function accountUsageRows(
  pool: LimitPool,
  now: number,
): {
  readonly columns: ReadonlyArray<AccountUsageColumn>;
  readonly rows: ReadonlyArray<AccountUsageRow>;
} {
  const windows = displayLimitWindows(pool);
  const columns = windows.map(({ id, kind, label }) => ({ id, kind, label }));
  const rows = pool.accounts.map((account): AccountUsageRow => {
    const unread = account.limits.windows.length === 0;
    return {
      account,
      current: account.current === true,
      readAgoMs:
        account.snapshot && !unread
          ? Math.max(0, now - Date.parse(account.limits.checkedAt))
          : null,
      unread,
      exhaustedUntil:
        account.exhaustedUntil !== undefined && account.exhaustedUntil > now
          ? account.exhaustedUntil
          : null,
      cells: windows.map(
        (window) => window.members.find((member) => member.account.key === account.key) ?? null,
      ),
    };
  });
  return {
    columns,
    rows: [...rows.filter((row) => row.current), ...rows.filter((row) => !row.current)],
  };
}
