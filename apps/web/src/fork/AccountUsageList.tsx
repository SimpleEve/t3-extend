// fork: Usage > Limits for an Antigravity pool of several Google accounts, one compact row each.
// Everything the segment card shows is kept: the pooled share with its pace and next refill, a pace
// tick on every bar, the refill hatching, reset credits, and the segment popover on each cell.
import { accountRefreshTarget } from "@t3tools/client-runtime/fork/antigravityAccounts/refresh";
import {
  accountUsageGroups,
  accountUsageRows,
  type AccountUsageColumn,
  type AccountUsageGroup,
  type AccountUsageRow,
} from "@t3tools/client-runtime/fork/antigravityAccounts/usageRows";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  paceOf,
  paceRemainingPercent,
  remainingPercent,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { formatReadAgo, formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { useGT, useMessages } from "gt-react";
import { TicketIcon } from "lucide-react";
import { type ReactNode, use } from "react";

import {
  AccountChip,
  SegmentPopoverContext,
  type SegmentPayload,
} from "../components/usage/UsageLimitsPooled";
import {
  PaceIcon,
  ResetCreditDialog,
  usePaceMark,
  useResetCredit,
} from "../components/usage/UsageLimits";
import { Badge } from "../components/ui/badge";
import { PopoverTrigger } from "../components/ui/popover";
import { useT } from "../hooks/useT";
import { cn } from "../lib/utils";
import {
  ProbeFailureNote,
  RefreshAccountButton,
  RefreshAllAccountsButton,
  useAccountUsageRefresh,
  type AccountUsageRefresh,
} from "./RefreshAccountUsage";

function CellBar({
  remaining,
  color,
  refillPercent,
  paceLeft,
}: {
  readonly remaining: number;
  readonly color: string;
  readonly refillPercent: number;
  /** Share of the window still to run, where an even pace would stand; null draws no tick. */
  readonly paceLeft: number | null;
}) {
  const [barRef, paceMark] = usePaceMark(paceLeft);
  return (
    <div
      ref={barRef}
      aria-hidden
      className="relative h-1 w-14 shrink-0 rounded-full bg-foreground/10"
    >
      <div className="absolute inset-0 overflow-hidden rounded-full">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${remaining}%`, backgroundColor: color }}
        />
        {remaining < 100 && refillPercent > 0 ? (
          <div
            className="absolute inset-y-0 right-0 opacity-60"
            style={{
              width: `${Math.min(100 - remaining, refillPercent)}%`,
              backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 3px)`,
            }}
          />
        ) : null}
      </div>
      {paceMark ? (
        <span
          className="absolute -inset-y-[3px] w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={paceMark.tick}
        />
      ) : null}
    </div>
  );
}

function AccountCell({
  row,
  member,
  reset,
  label,
  name,
  color,
  now,
  redeem,
}: {
  readonly row: AccountUsageRow;
  readonly member: LimitPoolMember;
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  /** The window's full label, for assistive technology. */
  readonly label: string;
  readonly name: string;
  readonly color: string;
  readonly now: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const popover = use(SegmentPopoverContext) ?? undefined;
  const { account } = row;
  const { window } = member;
  const remaining = remainingPercent(window);
  const timeLeft = row.paceMeaningful ? paceRemainingPercent(window, now) : null;
  const pace = row.paceMeaningful ? paceOf(window, now) : null;
  const resetsIn = formatResetsIn(window, now, m);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  const payload: SegmentPayload = {
    account,
    window,
    reset,
    redeem,
    readAgoMs: row.readAgoMs,
    paceMeaningful: row.paceMeaningful,
  };
  const ariaLabel = [
    gt("{name}: {remaining}% left", {
      name: `${account.email ?? account.driver} ${label}`,
      remaining,
    }),
    resetsIn,
    timeLeft === null ? null : gt("{timeLeft}% of the window left", { timeLeft }),
    credits
      ? gt(
          "{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}",
          { count: credits },
        )
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-12 shrink-0 truncate text-2xs text-muted-foreground">{name}</span>
      <PopoverTrigger
        handle={popover}
        payload={payload}
        openOnHover
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            className="flex shrink-0 cursor-pointer items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[popup-open]:bg-muted/60"
          />
        }
      >
        <CellBar
          remaining={remaining}
          color={color}
          refillPercent={window.resetsAt ? member.refillPercent : 0}
          paceLeft={timeLeft}
        />
        <span className="w-9 shrink-0 text-end text-xs font-medium text-foreground tabular-nums">
          {remaining}%
        </span>
      </PopoverTrigger>
      {pace ? <PaceIcon pace={pace} /> : null}
      {resetsIn ? (
        <span className="min-w-0 truncate text-2xs text-muted-foreground tabular-nums">
          {resetsIn}
        </span>
      ) : null}
      {credits ? (
        <span
          aria-hidden
          className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-semibold text-foreground"
        >
          <TicketIcon className="size-3" aria-hidden />
          {credits}
        </span>
      ) : null}
    </div>
  );
}

/** Owns the confirm dialog and progress line that a redeemable account's cells share. */
function RedeemableCell({
  redeemAt,
  ...props
}: Omit<Parameters<typeof AccountCell>[0], "redeem"> & {
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
}) {
  const redeem = useResetCredit(redeemAt.environmentId);
  const gt = useGT();
  return (
    <>
      <AccountCell redeem={redeem} {...props} />
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        choice={redeem.choice}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {redeem.busy || redeem.status ? (
        <span role="status" className="text-2xs text-muted-foreground">
          {redeem.busy ? gt("Using reset credit…") : redeem.status}
        </span>
      ) : null}
    </>
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
    <div role="group" aria-label={family ?? undefined} className="flex min-w-0 flex-col gap-0.5">
      {family ? <span className="truncate text-2xs text-muted-foreground">{family}</span> : null}
      {children}
    </div>
  );
}

const GROUPS_GRID = "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-1.5";
const ROW_GRID =
  "grid gap-x-6 gap-y-1.5 px-3 py-2 @2xl/accounts:grid-cols-[14rem_minmax(0,1fr)] @2xl/accounts:items-center";

function PooledRow({
  windows,
  groups,
  accounts,
  color,
  refresh,
}: {
  readonly windows: ReadonlyArray<LimitPoolWindow>;
  readonly groups: ReadonlyArray<AccountUsageGroup>;
  readonly accounts: ReadonlyArray<LimitAccount>;
  readonly color: string;
  readonly refresh: AccountUsageRefresh;
}) {
  const gt = useGT();
  const t = useT();
  const count = accounts.length;
  return (
    <li className={cn(ROW_GRID, "bg-muted/30")}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">
            {gt("All accounts", { $context: "usage pooled over every saved account" })}
          </span>
          <span className="shrink-0">
            <RefreshAllAccountsButton accounts={accounts} controller={refresh} />
          </span>
        </div>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {gt("{count, plural, one {{count} account} other {{count} accounts}}", { count })}
        </span>
        {refresh.failed ? (
          <span role="status" className="text-2xs text-destructive">
            {t("Could not start the refresh. Try again.")}
          </span>
        ) : null}
      </div>
      <div className={GROUPS_GRID}>
        {groups.map((group) => (
          <FamilyGroup key={group.family ?? ""} family={group.family}>
            {group.windows.map(({ index, name }) => {
              const window = windows[index];
              if (!window) return null;
              const nextRefill = window.resets.find((reset) => reset.restoresPercent > 0);
              return (
                <div key={index} className="flex min-w-0 items-center gap-2">
                  <span className="w-12 shrink-0 truncate text-2xs text-muted-foreground">
                    {name}
                  </span>
                  <CellBar
                    remaining={window.remainingPercent}
                    color={color}
                    refillPercent={0}
                    paceLeft={null}
                  />
                  <span className="w-9 shrink-0 text-end text-xs font-semibold text-foreground tabular-nums">
                    {window.remainingPercent}%
                  </span>
                  {window.pace ? <PaceIcon pace={window.pace} /> : null}
                  {nextRefill ? (
                    <span className="text-2xs font-medium text-foreground tabular-nums">
                      ↻ +{nextRefill.restoresPercent}%
                    </span>
                  ) : null}
                </div>
              );
            })}
          </FamilyGroup>
        ))}
      </div>
    </li>
  );
}

function AccountUsageRowItem({
  row,
  groups,
  columns,
  windows,
  position,
  color,
  now,
  refresh,
}: {
  readonly row: AccountUsageRow;
  readonly groups: ReadonlyArray<AccountUsageGroup>;
  readonly columns: ReadonlyArray<AccountUsageColumn>;
  readonly windows: ReadonlyArray<LimitPoolWindow>;
  readonly position: number;
  readonly color: string;
  readonly now: number;
  readonly refresh: AccountUsageRefresh;
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
  const accent = normalizeProviderAccentColor(account.accentColor) ?? color;
  const refreshTarget = accountRefreshTarget(account);
  return (
    <li className={cn(ROW_GRID, spent && "bg-muted/30")}>
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
          {refreshTarget === null ? null : (
            <span className="shrink-0">
              <RefreshAccountButton
                target={refreshTarget}
                controller={refresh}
                label={t("Refresh this account")}
              />
            </span>
          )}
        </div>
        {note ? <span className="text-2xs text-muted-foreground tabular-nums">{note}</span> : null}
        <ProbeFailureNote account={account} />
      </div>
      <div
        className={cn(
          GROUPS_GRID,
          (spent || row.readAgoMs !== null) && "opacity-70",
          row.unread && "hidden",
        )}
      >
        {groups.map((group) => (
          <FamilyGroup key={group.family ?? ""} family={group.family}>
            {group.windows.map(({ index, name: windowName }) => {
              const member = row.cells[index];
              if (!member) return null;
              const props = {
                row,
                member,
                reset: windows[index]?.resets.find(
                  (entry) => entry.member.account.key === account.key,
                ),
                label: columns[index]?.label ?? windowName,
                name: windowName,
                color: accent,
                now,
              };
              return account.redeem ? (
                <RedeemableCell key={index} redeemAt={account.redeem} {...props} />
              ) : (
                <AccountCell key={index} redeem={null} {...props} />
              );
            })}
          </FamilyGroup>
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
  const { columns, windows, rows } = accountUsageRows(pool, now);
  const groups = accountUsageGroups(columns);
  const refresh = useAccountUsageRefresh();
  return (
    <ul className="@container/accounts flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
      <PooledRow
        windows={windows}
        groups={groups}
        accounts={pool.accounts}
        color={color}
        refresh={refresh}
      />
      {rows.map((row, index) => (
        <AccountUsageRowItem
          key={row.account.key}
          row={row}
          groups={groups}
          columns={columns}
          windows={windows}
          position={index + 1}
          color={color}
          now={now}
          refresh={refresh}
        />
      ))}
    </ul>
  );
}
