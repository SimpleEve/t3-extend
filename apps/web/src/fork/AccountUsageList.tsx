// fork: Usage > Limits for an Antigravity pool of several Google accounts, one compact row each.
import {
  accountUsageGroups,
  accountUsageRows,
  type AccountUsageGroup,
  type AccountUsageRow,
} from "@t3tools/client-runtime/fork/antigravityAccounts/usageRows";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { remainingPercent, type LimitPool } from "@t3tools/shared/usageLimits";
import { formatReadAgo, formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { useGT, useMessages } from "gt-react";

import { AccountChip } from "../components/usage/UsageLimitsPooled";
import { Badge } from "../components/ui/badge";
import { useT } from "../hooks/useT";
import { cn } from "../lib/utils";

function FamilyGroup({
  group,
  row,
  color,
  now,
}: {
  readonly group: AccountUsageGroup;
  readonly row: AccountUsageRow;
  readonly color: string;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const cells = group.windows.flatMap(({ index, name }) => {
    const member = row.cells[index];
    return member ? [{ index, name, member }] : [];
  });
  if (cells.length === 0) return <div aria-hidden />;
  return (
    <div
      role="group"
      aria-label={group.family ?? undefined}
      className="flex min-w-0 flex-col gap-0.5"
    >
      {group.family ? (
        <span className="truncate text-2xs text-muted-foreground">{group.family}</span>
      ) : null}
      {cells.map(({ index, name, member }) => {
        const remaining = remainingPercent(member.window);
        const resets = formatResetsIn(member.window, now, m);
        return (
          <div
            key={index}
            role="group"
            aria-label={gt("{name}: {remaining}% left", { name, remaining })}
            className="flex min-w-0 items-center gap-2"
          >
            <span className="w-12 shrink-0 truncate text-2xs text-muted-foreground">{name}</span>
            <div
              aria-hidden
              className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-foreground/10"
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${remaining}%`, backgroundColor: color }}
              />
            </div>
            <span className="w-9 shrink-0 text-end text-xs font-medium text-foreground tabular-nums">
              {remaining}%
            </span>
            {resets ? (
              <span className="min-w-0 truncate text-2xs text-muted-foreground tabular-nums">
                {resets}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AccountUsageRowItem({
  row,
  groups,
  position,
  color,
  now,
}: {
  readonly row: AccountUsageRow;
  readonly groups: ReadonlyArray<AccountUsageGroup>;
  readonly position: number;
  readonly color: string;
  readonly now: number;
}) {
  const gt = useGT();
  const t = useT();
  const m = useMessages();
  const { account } = row;
  const name = account.email ?? t("Account {number}", { number: position });
  const spent = row.exhaustedUntil !== null;
  const note = row.unread
    ? gt("No reading yet")
    : row.readAgoMs === null
      ? null
      : formatReadAgo(row.readAgoMs, m);
  return (
    <li
      className={cn(
        "grid gap-x-6 gap-y-1.5 px-3 py-2 @2xl/accounts:grid-cols-[14rem_minmax(0,1fr)] @2xl/accounts:items-center",
        spent && "bg-muted/30",
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {account.email ? <AccountChip email={account.email} /> : null}
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium",
              spent ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {name}
          </span>
          {row.current ? (
            <Badge size="sm" variant="secondary">
              {gt("Current", { $context: "the account in use" })}
            </Badge>
          ) : null}
        </div>
        {note ? <span className="text-2xs text-muted-foreground tabular-nums">{note}</span> : null}
      </div>
      <div
        className={cn(
          "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-1.5",
          (spent || row.readAgoMs !== null) && "opacity-70",
        )}
      >
        {groups.map((group) => (
          <FamilyGroup
            key={group.family ?? ""}
            group={group}
            row={row}
            color={normalizeProviderAccentColor(account.accentColor) ?? color}
            now={now}
          />
        ))}
      </div>
    </li>
  );
}

export function AccountUsageList({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPool;
  readonly color: string;
  readonly now: number;
}) {
  const { columns, rows } = accountUsageRows(pool, now);
  const groups = accountUsageGroups(columns);
  return (
    <ul className="@container/accounts flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
      {rows.map((row, index) => (
        <AccountUsageRowItem
          key={row.account.key}
          row={row}
          groups={groups}
          position={index + 1}
          color={color}
          now={now}
        />
      ))}
    </ul>
  );
}
