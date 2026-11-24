import {
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
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
  /** Whether pace marks may be drawn for this row; false for an old remembered reading. */
  readonly paceMeaningful: boolean;
  /** One per column, in column order; null where the account reports no such window. */
  readonly cells: ReadonlyArray<LimitPoolMember | null>;
}

/**
 * How old a remembered reading may be and still say anything about pace. Pace compares what was
 * used with how much of the window has passed, so a reading that stopped refreshing misleads.
 */
const PACE_STALE_AFTER_MS = 30 * 60_000;

/** A live reading, or a remembered one young enough that the pace it implies still holds. */
export function paceIsMeaningful(account: LimitAccount, now: number): boolean {
  if (!account.snapshot) return true;
  const checkedAt = Date.parse(account.limits.checkedAt);
  return Number.isFinite(checkedAt) && now - checkedAt <= PACE_STALE_AFTER_MS;
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
  /** The pool's own windows, in column order: the pooled share left, its pace and next refill. */
  readonly windows: ReadonlyArray<LimitPoolWindow>;
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
      paceMeaningful: paceIsMeaningful(account, now),
      cells: windows.map(
        (window) => window.members.find((member) => member.account.key === account.key) ?? null,
      ),
    };
  });
  return {
    columns,
    windows,
    rows: [...rows.filter((row) => row.current), ...rows.filter((row) => !row.current)],
  };
}

export interface AccountUsageGroup {
  /** The model family a window belongs to ("Gemini"); null for a label that names none. */
  readonly family: string | null;
  readonly windows: ReadonlyArray<{
    /** Position in `columns`, and so in a row's `cells`. */
    readonly index: number;
    /** What is left of the label once the family is taken off ("5-hour"). */
    readonly name: string;
  }>;
}

/** Windows are labelled "Family · Window"; the list shows each family once, over its windows. */
export function accountUsageGroups(
  columns: ReadonlyArray<AccountUsageColumn>,
): ReadonlyArray<AccountUsageGroup> {
  const groups = new Map<string | null, AccountUsageGroup["windows"][number][]>();
  columns.forEach((column, index) => {
    const separator = column.label.lastIndexOf(" · ");
    const family = separator > 0 ? column.label.slice(0, separator) : null;
    const name = separator > 0 ? column.label.slice(separator + 3) : column.label;
    groups.set(family, [...(groups.get(family) ?? []), { index, name }]);
  });
  return [...groups].map(([family, windows]) => ({ family, windows }));
}
