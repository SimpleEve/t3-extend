// fork: Settings → Antigravity → the Google accounts a separate sign-in keeps.
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  antigravityAccountLowest,
  antigravityAccountRows,
  formatAntigravityReset,
  type AntigravityAccountRow,
} from "@t3tools/client-runtime/fork/antigravityAccounts/accounts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { formatReadAgo } from "@t3tools/shared/usageLimitsCopy";
import { useAtomValue } from "@effect/atom-react";
import { useMessages } from "gt-react";
import { useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { SettingsRow } from "../components/settings/settingsLayout";
import { useNowMinute } from "../hooks/useNowMinute";
import { useT, useUiLocale } from "../hooks/useT";
import { ensureLocalApi } from "../localApi";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const STALE_LIVE_READING_MS = 15 * 60_000;

export function AntigravityAccounts({
  environmentId,
  provider,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}) {
  const t = useT();
  const m = useMessages();
  const locale = useUiLocale();
  const now = Date.parse(`${useNowMinute()}Z`);
  const rows = antigravityAccountRows(provider);
  const commands = { reportFailure: false, reportDefect: false };
  const select = useAtomCommand(serverEnvironment.selectProviderAuthMethod, commands);
  const remove = useAtomCommand(serverEnvironment.removeProviderAuthMethod, commands);
  const canManage = useAtomValue(
    serverEnvironment.selectProviderAuthMethod.permissionAtom(environmentId),
  );
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  if (rows.length === 0) return null;

  const label = (row: AntigravityAccountRow) =>
    row.email === null ? t("Account {number}", { number: row.position }) : row.email;
  // What is left of the account's quota; a reading of an account not in use says how old it is.
  const lowest = (row: AntigravityAccountRow) => {
    const found =
      row.exhaustedUntil === null ? antigravityAccountLowest(row.usageLimits, now) : null;
    if (found === null) return null;
    const left = t("{remaining}% left", { remaining: found.remaining });
    // The account in use is read live; only a reading that has stopped refreshing is dated.
    return row.current && found.readAgoMs < STALE_LIVE_READING_MS
      ? left
      : `${left} · ${formatReadAgo(found.readAgoMs, m)}`;
  };

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await command();
      if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? (thrownErrorMessage(failure, m) ?? failure.message)
            : t("Could not change the account. Try again."),
        );
      }
    } catch {
      setError(t("Could not change the account. Try again."));
    }
    pendingRef.current = false;
    setPending(false);
  }

  const act = (row: AntigravityAccountRow, change: typeof select, question: string) => {
    void ensureLocalApi()
      .dialogs.confirm(question)
      .then((confirmed) => {
        if (confirmed) {
          void run(() =>
            change({
              environmentId,
              input: { instanceId: provider.instanceId, methodId: row.id },
            }),
          );
        }
      });
  };
  const disabled = readOnly || pending || !canManage;

  return (
    <SettingsRow
      title={t("Saved accounts")}
      description={t(
        "Change account keeps the account in use and adds the one you sign in with. The account in use runs new turns.",
      )}
      status={
        error === null ? undefined : (
          <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
            {error}
          </p>
        )
      }
    >
      <ul className="divide-y divide-border/60">
        {rows.map((row) => {
          const left = lowest(row);
          return (
            <li key={row.id} className="flex min-w-0 items-center gap-2 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{label(row)}</div>
                <div className="text-xs text-muted-foreground">
                  {row.current
                    ? t("In use")
                    : row.exhaustedUntil !== null
                      ? t("Out of quota until {time}", {
                          time: formatAntigravityReset(row.exhaustedUntil, locale),
                        })
                      : t("Saved")}
                  {row.current && row.exhaustedUntil !== null
                    ? ` · ${t("Out of quota until {time}", {
                        time: formatAntigravityReset(row.exhaustedUntil, locale),
                      })}`
                    : null}
                  {left ? ` · ${left}` : null}
                </div>
              </div>
              {row.current ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    act(
                      row,
                      select,
                      t(
                        "Use {account}? Running threads on this instance stop, and new turns use this account.",
                        { account: label(row) },
                      ),
                    )
                  }
                >
                  {t("Use")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  act(
                    row,
                    remove,
                    t(
                      "Remove {account}? Running threads on this instance stop. Sign in again to add it back.",
                      { account: label(row) },
                    ),
                  )
                }
              >
                {t("Remove")}
              </Button>
            </li>
          );
        })}
      </ul>
    </SettingsRow>
  );
}
