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

import { Button } from "../components/ui/button";
import { RefreshIcon } from "../components/ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useT } from "../hooks/useT";
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

/** A small button that reads the account (or, without an account id, every other account). */
export function RefreshAccountButton({
  target,
  controller,
  label,
}: {
  readonly target: AccountRefreshTarget;
  readonly controller: AccountUsageRefresh;
  readonly label: string;
}) {
  const t = useT();
  const canManage = useAtomValue(
    serverEnvironment.refreshProviderAuthAccounts.permissionAtom(target.environmentId),
  );
  const busy = controller.isBusy(target);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={busy ? t("Refreshing…") : label}
            aria-busy={busy}
            disabled={!canManage || busy}
            onClick={() => void controller.refresh(target)}
          />
        }
      >
        <RefreshIcon refreshing={busy} />
      </TooltipTrigger>
      <TooltipPopup side="top">{busy ? t("Refreshing…") : label}</TooltipPopup>
    </Tooltip>
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
    <span role="status" className="text-2xs text-destructive">
      {t("Could not refresh: {reason}", { reason })}
    </span>
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
  const label = busy ? t("Refreshing…") : t("Refresh other accounts");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            aria-busy={busy}
            disabled={permitted.length === 0 || busy}
            onClick={() => {
              for (const target of permitted) void controller.refresh(target);
            }}
          />
        }
      >
        <RefreshIcon refreshing={busy} />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
