// fork: reads the quota of Antigravity accounts that are not in use, from Usage > Limits.
import { useAtomValue } from "@effect/atom-react";
import {
  accountRefreshFailed,
  accountRefreshKey,
  accountRefreshRequest,
  accountRefreshTargets,
  permittedRefreshTargets,
  refreshEnvironmentsKey,
  type AccountRefreshTarget,
} from "@t3tools/client-runtime/fork/antigravityAccounts/refresh";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { useRef, useState } from "react";
import { Pressable } from "react-native";

import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { SymbolView } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import { useT } from "../hooks/useT";
import { cn } from "../lib/cn";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

export interface AccountUsageRefresh {
  readonly isBusy: (target: AccountRefreshTarget) => boolean;
  readonly refresh: (target: AccountRefreshTarget) => Promise<void>;
  /** The last request that could not be made, not a read that failed on the server. */
  readonly failed: boolean;
}

/** One request per account at a time; a read of every account holds all of that instance's rows. */
export function useAccountUsageRefresh(): AccountUsageRefresh {
  const command = useAtomCommand(serverEnvironment.refreshProviderAuthAccounts, {
    reportFailure: false,
    reportDefect: false,
  });
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const mark = (next: ReadonlySet<string>) => {
    busyRef.current = next;
    setBusy(next);
  };
  const isBusy = (target: AccountRefreshTarget) =>
    busy.has(accountRefreshKey(target)) || busy.has(accountRefreshKey(target, true));
  const refresh = async (target: AccountRefreshTarget) => {
    const key = accountRefreshKey(target);
    if (busyRef.current.has(key) || busyRef.current.has(accountRefreshKey(target, true))) return;
    mark(new Set([...busyRef.current, key]));
    setFailed(false);
    const result: AtomCommandResult<unknown, unknown> | undefined = await command(
      accountRefreshRequest(target),
    ).catch(() => undefined);
    mark(new Set([...busyRef.current].filter((entry) => entry !== key)));
    if (accountRefreshFailed(result)) setFailed(true);
  };
  return { isBusy, refresh, failed };
}

function RefreshPressable({
  accessibilityLabel,
  busy,
  disabled,
  onPress,
}: {
  readonly accessibilityLabel: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy, disabled: disabled || busy }}
      disabled={disabled || busy}
      hitSlop={10}
      onPress={onPress}
      className={cn(
        "size-6 items-center justify-center active:opacity-60",
        disabled && "opacity-40",
      )}
    >
      {busy ? (
        <AppActivityIndicator size="small" colorClassName="accent-icon" />
      ) : (
        <SymbolView name="arrow.clockwise" size={14} tintColorClassName="accent-icon" />
      )}
    </Pressable>
  );
}

/** A small button that reads one account that is not in use. */
export function RefreshAccountButton({
  target,
  controller,
}: {
  readonly target: AccountRefreshTarget;
  readonly controller: AccountUsageRefresh;
}) {
  const t = useT();
  const canManage = useAtomValue(
    serverEnvironment.refreshProviderAuthAccounts.permissionAtom(target.environmentId),
  );
  const busy = controller.isBusy(target);
  return (
    <RefreshPressable
      accessibilityLabel={busy ? t("Refreshing…") : t("Refresh this account")}
      busy={busy}
      disabled={!canManage}
      onPress={() => void controller.refresh(target)}
    />
  );
}

/** Reads every account that is not in use, on each instance the pool's accounts belong to. */
export function RefreshAllAccountsButton({
  accounts,
  controller,
}: {
  readonly accounts: ReadonlyArray<LimitAccount>;
  readonly controller: AccountUsageRefresh;
}) {
  const t = useT();
  const targets = accountRefreshTargets(accounts);
  // Each environment's own grant decides whether its accounts are refreshed with the rest.
  const permitted = permittedRefreshTargets(
    targets,
    useAtomValue(
      serverEnvironment.permittedRefreshEnvironmentsAtom(refreshEnvironmentsKey(targets)),
    ),
  );
  if (targets.length === 0) return null;
  const busy = permitted.some((target) => controller.isBusy(target));
  return (
    <RefreshPressable
      accessibilityLabel={busy ? t("Refreshing…") : t("Refresh other accounts")}
      busy={busy}
      disabled={permitted.length === 0}
      onPress={() => {
        for (const target of permitted) void controller.refresh(target);
      }}
    />
  );
}

/** Why the last background read of an account failed, as a line under its name. */
export function ProbeFailureNote({ account }: { readonly account: LimitAccount }) {
  const t = useT();
  const failure = account.probeFailure;
  if (failure === undefined) return null;
  const reason =
    failure.reason === "expired"
      ? t("sign-in expired, sign in to this account again")
      : failure.reason === "timeout"
        ? t("timed out")
        : failure.reason === "unavailable"
          ? t("quota could not be read")
          : t("unexpected error");
  return (
    <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
      {t("Could not refresh: {reason}", { reason })}
    </Text>
  );
}
