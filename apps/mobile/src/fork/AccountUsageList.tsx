// fork: Usage > Limits for an Antigravity pool of several Google accounts, one compact block each.
import {
  accountUsageGroups,
  accountUsageRows,
  type AccountUsageGroup,
  type AccountUsageRow,
} from "@t3tools/client-runtime/fork/antigravityAccounts/usageRows";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { remainingPercent, type LimitPool } from "@t3tools/shared/usageLimits";
import { formatReadAgo } from "@t3tools/shared/usageLimitsCopy";
import { useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { cn } from "../lib/cn";
import { AccountChip } from "../features/usage/UsageLimitsPooled";
import { resetLabels } from "../features/usage/UsageLimitsSection";
import { useT } from "../hooks/useT";

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
  if (cells.length === 0) return null;
  return (
    <View className="gap-1">
      {group.family ? (
        <Text numberOfLines={1} className="text-xs text-foreground-muted">
          {group.family}
        </Text>
      ) : null}
      {cells.map(({ index, name, member }) => {
        const remaining = remainingPercent(member.window);
        const resets = resetLabels(member.window, now, m)?.full;
        return (
          <View
            key={index}
            accessible
            accessibilityLabel={[
              gt("{name}: {remaining}% left", { name, remaining }),
              resets ?? null,
            ]
              .filter(Boolean)
              .join(", ")}
            className="flex-row items-center gap-2"
          >
            <Text numberOfLines={1} className="w-12 text-xs text-foreground-muted">
              {name}
            </Text>
            <View className="h-1 w-14 overflow-hidden rounded-full bg-subtle-strong">
              <View
                className="h-full rounded-full"
                style={{ width: `${remaining}%`, backgroundColor: color }}
              />
            </View>
            <Text className="w-9 text-right text-xs font-t3-medium tabular-nums text-foreground">
              {remaining}%
            </Text>
            {resets ? (
              <Text
                numberOfLines={1}
                className="min-w-0 shrink text-xs tabular-nums text-foreground-muted"
              >
                {resets}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function AccountBlock({
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
  const spent = row.exhaustedUntil !== null;
  const note = row.unread
    ? gt("No reading yet")
    : row.readAgoMs === null
      ? null
      : formatReadAgo(row.readAgoMs, m);
  return (
    <View className="gap-2 px-4 py-3">
      <View className="gap-0.5">
        <View className="flex-row items-center gap-1.5">
          {account.email ? <AccountChip email={account.email} /> : null}
          <Text
            numberOfLines={1}
            className={cn(
              "min-w-0 shrink text-sm font-t3-medium",
              spent ? "text-foreground-muted" : "text-foreground",
            )}
          >
            {account.email ?? t("Account {number}", { number: position })}
          </Text>
          {row.current ? (
            <View className="rounded bg-subtle-strong px-1.5 py-0.5">
              <Text className="text-xs font-t3-medium text-foreground">
                {gt("Current", { $context: "the account in use" })}
              </Text>
            </View>
          ) : null}
        </View>
        {note ? <Text className="text-xs text-foreground-muted">{note}</Text> : null}
      </View>
      <View className={cn("gap-2", (spent || row.readAgoMs !== null) && "opacity-70")}>
        {groups.map((group) => (
          <FamilyGroup
            key={group.family ?? ""}
            group={group}
            row={row}
            color={normalizeProviderAccentColor(account.accentColor) ?? color}
            now={now}
          />
        ))}
      </View>
    </View>
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
    <View className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card">
      {rows.map((row, index) => (
        <View key={row.account.key} className={index === 0 ? "" : "border-t border-border-subtle"}>
          <AccountBlock row={row} groups={groups} position={index + 1} color={color} now={now} />
        </View>
      ))}
    </View>
  );
}
