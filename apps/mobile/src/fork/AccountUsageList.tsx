// fork: Usage > Limits for an Antigravity pool of several Google accounts, one compact block each.
// Keeps what the segment card has: the pooled share with its pace and next refill, a pace tick on
// every bar, the refill shading, reset credits, and a tap through to the account's details.
import { useNavigation } from "@react-navigation/native";
import { accountRefreshTarget } from "@t3tools/client-runtime/fork/antigravityAccounts/refresh";
import {
  accountUsageGroups,
  accountUsageRows,
  type AccountUsageColumn,
  type AccountUsageGroup,
  type AccountUsageRow,
  type AccountUsageSection,
} from "@t3tools/client-runtime/fork/antigravityAccounts/usageRows";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  paceRemainingPercent,
  remainingPercent,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { formatReadAgo } from "@t3tools/shared/usageLimitsCopy";
import { useGT, useMessages } from "gt-react-native";
import { type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import { cn } from "../lib/cn";
import { AccountChip, PACE_LABEL } from "./accountChip";
import { refillLabel, resetLabels } from "../features/usage/UsageLimitsSection";
import { useT } from "../hooks/useT";
import {
  ProbeFailureNote,
  RefreshAccountButton,
  RefreshAllAccountsButton,
  useAccountUsageRefresh,
  type AccountUsageRefresh,
} from "./RefreshAccountUsage";

function Bar({
  remaining,
  color,
  refillPercent,
  paceLeft,
}: {
  readonly remaining: number;
  readonly color: string;
  readonly refillPercent: number;
  /** Where an even pace would stand; null draws no tick. */
  readonly paceLeft: number | null;
}) {
  return (
    <View className="relative h-1 w-14 rounded-full bg-subtle-strong">
      <View className="absolute inset-0 overflow-hidden rounded-full">
        <View
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${remaining}%`, backgroundColor: color }}
        />
        {remaining < 100 && refillPercent > 0 ? (
          <View
            className="absolute inset-y-0 right-0"
            style={{
              width: `${Math.min(100 - remaining, refillPercent)}%`,
              backgroundColor: color,
              opacity: 0.35,
            }}
          />
        ) : null}
      </View>
      {paceLeft === null ? null : (
        <View
          pointerEvents="none"
          className="absolute -bottom-0.5 -top-0.5 w-0.5 rounded-full bg-foreground"
          style={{ left: `${Math.min(Math.max(paceLeft, 3), 97)}%`, marginLeft: -1 }}
        />
      )}
    </View>
  );
}

function FamilyGroup({
  family,
  children,
}: {
  readonly family: string | null;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-1">
      {family ? (
        <Text numberOfLines={1} className="text-xs text-foreground-muted">
          {family}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

function AccountCell({
  row,
  window,
  refillPercent,
  label,
  name,
  color,
  now,
  onOpen,
}: {
  readonly row: AccountUsageRow;
  readonly window: NonNullable<AccountUsageRow["cells"][number]>["window"];
  readonly refillPercent: number;
  readonly label: string;
  readonly name: string;
  readonly color: string;
  readonly now: number;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { account } = row;
  const remaining = remainingPercent(window);
  const timeLeft = row.paceMeaningful ? paceRemainingPercent(window, now) : null;
  const resets = resetLabels(window, now, m);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        gt("{name}: {remaining}% left", {
          name: `${account.email ?? account.driver} ${label}`,
          remaining,
        }),
        resets?.full ?? null,
        timeLeft === null ? null : gt("{timeLeft}% of the window left", { timeLeft }),
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={gt("Show account details")}
      onPress={onOpen}
      className="min-h-6 flex-row items-center gap-2 active:opacity-60"
    >
      <Text numberOfLines={1} className="w-16 text-xs text-foreground-muted">
        {name}
      </Text>
      <Bar remaining={remaining} color={color} refillPercent={refillPercent} paceLeft={timeLeft} />
      <Text
        numberOfLines={1}
        className="w-11 text-right text-xs font-t3-medium tabular-nums text-foreground"
      >
        {remaining}%
      </Text>
      {resets ? (
        <Text
          numberOfLines={1}
          className="min-w-0 shrink text-xs tabular-nums text-foreground-muted"
        >
          {resets.full}
        </Text>
      ) : null}
      {credits ? (
        <View className="flex-row items-center gap-0.5">
          <SymbolView name="ticket" size={12} tintColorClassName="accent-icon" />
          <Text className="text-xs font-t3-medium tabular-nums text-foreground">{credits}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function PooledBlock({
  windows,
  groups,
  accounts,
  color,
  now,
  refresh,
}: {
  readonly windows: ReadonlyArray<LimitPoolWindow>;
  readonly groups: ReadonlyArray<AccountUsageGroup>;
  readonly accounts: ReadonlyArray<LimitAccount>;
  readonly color: string;
  readonly now: number;
  readonly refresh: AccountUsageRefresh;
}) {
  const gt = useGT();
  const t = useT();
  const m = useMessages();
  const count = accounts.length;
  return (
    <View className="gap-2 bg-subtle px-4 py-3">
      <View className="gap-0.5">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-sm font-t3-medium text-foreground">
            {gt("All accounts", { $context: "usage pooled over every saved account" })}
          </Text>
          <RefreshAllAccountsButton accounts={accounts} controller={refresh} />
        </View>
        <Text className="text-xs text-foreground-muted">
          {gt("{count, plural, one {{count} account} other {{count} accounts}}", { count })}
        </Text>
        {refresh.failed ? (
          <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
            {t("Could not start the refresh. Try again.")}
          </Text>
        ) : null}
      </View>
      <View className="gap-2">
        {groups.map((group) => (
          <FamilyGroup key={group.family ?? ""} family={group.family}>
            {group.windows.map(({ index, name }) => {
              const window = windows[index];
              if (!window) return null;
              const nextRefill = window.resets.find((reset) => reset.restoresPercent > 0);
              return (
                <View key={index} className="min-h-6 flex-row flex-wrap items-center gap-x-2">
                  <Text numberOfLines={1} className="w-16 text-xs text-foreground-muted">
                    {name}
                  </Text>
                  <Bar
                    remaining={window.remainingPercent}
                    color={color}
                    refillPercent={0}
                    paceLeft={null}
                  />
                  <Text
                    numberOfLines={1}
                    className="w-11 text-right text-xs font-t3-bold tabular-nums text-foreground"
                  >
                    {window.remainingPercent}%
                  </Text>
                  {window.pace ? (
                    <Text className="text-xs text-foreground-tertiary">
                      {m(PACE_LABEL[window.pace])}
                    </Text>
                  ) : null}
                  {nextRefill ? (
                    <Text className="text-xs tabular-nums text-foreground-muted">
                      {refillLabel(nextRefill.member.window, now, nextRefill.restoresPercent, m)}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </FamilyGroup>
        ))}
      </View>
    </View>
  );
}

function AccountBlock({
  row,
  groups,
  columns,
  windows,
  color,
  now,
  environmentIds,
  refresh,
}: {
  readonly row: AccountUsageRow;
  readonly groups: ReadonlyArray<AccountUsageGroup>;
  readonly columns: ReadonlyArray<AccountUsageColumn>;
  readonly windows: ReadonlyArray<LimitPoolWindow>;
  readonly color: string;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
  readonly refresh: AccountUsageRefresh;
}) {
  const gt = useGT();
  const t = useT();
  const m = useMessages();
  const navigation = useNavigation();
  const { account } = row;
  const spent = row.exhaustedUntil !== null;
  const note = row.unread
    ? gt("No reading yet")
    : row.readAgoMs === null
      ? null
      : formatReadAgo(row.readAgoMs, m);
  const accent = normalizeProviderAccentColor(account.accentColor) ?? color;
  const refreshTarget = accountRefreshTarget(account);
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
            {account.email ?? t("Account {number}", { number: row.position })}
          </Text>
          {row.current ? (
            <View className="rounded bg-subtle-strong px-1.5 py-0.5">
              <Text className="text-xs font-t3-medium text-foreground">
                {gt("Current", { $context: "the account in use" })}
              </Text>
            </View>
          ) : null}
          {refreshTarget === null ? null : (
            <RefreshAccountButton target={refreshTarget} controller={refresh} />
          )}
        </View>
        {note ? <Text className="text-xs text-foreground-muted">{note}</Text> : null}
        <ProbeFailureNote account={account} />
      </View>
      {row.unread ? null : (
        <View className={cn("gap-2", (spent || row.readAgoMs !== null) && "opacity-70")}>
          {groups.map((group) => (
            <FamilyGroup key={group.family ?? ""} family={group.family}>
              {group.windows.map(({ index, name }) => {
                const member = row.cells[index];
                const poolWindow = windows[index];
                if (!member || !poolWindow) return null;
                return (
                  <AccountCell
                    key={index}
                    row={row}
                    window={member.window}
                    refillPercent={member.window.resetsAt ? member.refillPercent : 0}
                    label={columns[index]?.label ?? name}
                    name={name}
                    color={accent}
                    now={now}
                    onOpen={() =>
                      navigation.navigate("SettingsUsageAccount", {
                        accountKey: account.key,
                        windowId: poolWindow.id,
                        windowKind: poolWindow.kind,
                        environmentIds,
                      })
                    }
                  />
                );
              })}
            </FamilyGroup>
          ))}
        </View>
      )}
    </View>
  );
}

/** Names the machine, or machines, whose accounts follow. */
function MachineHeading({ section }: { readonly section: AccountUsageSection }) {
  const gt = useGT();
  const t = useT();
  const count = section.rows.length;
  return (
    <View
      accessibilityRole="header"
      className="flex-row items-baseline gap-2 border-t border-border-subtle bg-subtle px-4 py-2"
    >
      <Text numberOfLines={1} className="min-w-0 shrink text-xs font-t3-medium text-foreground">
        {section.label}
      </Text>
      <Text numberOfLines={1} className="text-xs tabular-nums text-foreground-muted">
        {section.shared
          ? t("On {count} machines", { count: section.machineCount })
          : gt("{count, plural, one {{count} account} other {{count} accounts}}", { count })}
      </Text>
    </View>
  );
}

export function AccountUsageList({
  pool,
  color,
  now,
  environmentIds,
}: {
  readonly pool: LimitPool;
  readonly color: string;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
}) {
  const { columns, windows, sections } = accountUsageRows(pool, now);
  const groups = accountUsageGroups(columns);
  const refresh = useAccountUsageRefresh();
  return (
    <View className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card">
      <PooledBlock
        windows={windows}
        groups={groups}
        accounts={pool.accounts}
        color={color}
        now={now}
        refresh={refresh}
      />
      {sections.map((section) => (
        <View key={section.key}>
          {section.label === null ? null : <MachineHeading section={section} />}
          {section.rows.map((row) => (
            <View key={row.account.key} className="border-t border-border-subtle">
              <AccountBlock
                row={row}
                groups={groups}
                columns={columns}
                windows={windows}
                color={color}
                now={now}
                environmentIds={environmentIds}
                refresh={refresh}
              />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
