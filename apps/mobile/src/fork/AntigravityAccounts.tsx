// fork: Settings → Providers → the Google accounts a separate Antigravity sign-in keeps.
import { minuteTick } from "@t3tools/client-runtime/clock";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  antigravityAccountLowest,
  antigravityAccountRows,
  formatAntigravityReset,
  maskAntigravityAccountEmail,
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
import type { MenuAction } from "@react-native-menu/menu";
import { useRef, useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import * as Dialog from "../components/ui/Dialog";
import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { AppText as Text } from "../components/ui/AppText";
import { ControlPill } from "../components/ui/ControlPill";
import { Menu } from "../components/ui/Menu";
import { useT, useUiLocale } from "../hooks/useT";
import { m } from "../i18n/messages";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const STALE_LIVE_READING_MS = 15 * 60_000;

export function AntigravityAccounts({
  environmentId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
}) {
  const t = useT();
  const locale = useUiLocale();
  const now = Date.parse(
    `${useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot)}Z`,
  );
  const rows = antigravityAccountRows(provider);
  const options = { reportFailure: false, reportDefect: false };
  const select = useAtomCommand(serverEnvironment.selectProviderAuthMethod, options);
  const remove = useAtomCommand(serverEnvironment.removeProviderAuthMethod, options);
  const canManage = useAtomValue(
    serverEnvironment.selectProviderAuthMethod.permissionAtom(environmentId),
  );
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  if (rows.length === 0) return null;

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await command();
    pendingRef.current = false;
    setPending(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, m) ?? failure.message)
          : t("Could not change the account. Try again."),
      );
    }
  }

  const label = (row: AntigravityAccountRow) =>
    row.email === null ? t("Account {number}", { number: row.position }) : row.email;
  const shown = (row: AntigravityAccountRow) =>
    row.email === null
      ? label(row)
      : revealed === row.id
        ? row.email
        : maskAntigravityAccountEmail(row.email);

  function confirm(
    row: AntigravityAccountRow,
    change: typeof select,
    question: string,
    action: string,
    destructive: boolean,
  ) {
    Dialog.alert(question, undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: action,
        style: destructive ? "destructive" : "default",
        onPress: () => {
          void run(() =>
            change({ environmentId, input: { instanceId: provider.instanceId, methodId: row.id } }),
          );
        },
      },
    ]);
  }

  return (
    <View className="border-t border-border-subtle">
      <View className="px-4 pt-3">
        <Text textRole="footnote" className="text-foreground-muted">
          {t("Saved accounts")}
        </Text>
      </View>
      {rows.map((row) => {
        const actions: MenuAction[] = [
          ...(row.current ? [] : [{ id: "use", title: t("Use") }]),
          { id: "remove", title: t("Remove"), attributes: { destructive: true } },
        ];
        const found =
          row.exhaustedUntil === null ? antigravityAccountLowest(row.usageLimits, now) : null;
        // The account in use is read live; only a reading that has stopped refreshing is dated.
        const left =
          found === null
            ? null
            : row.current && found.readAgoMs < STALE_LIVE_READING_MS
              ? t("{remaining}% left", { remaining: found.remaining })
              : `${t("{remaining}% left", { remaining: found.remaining })} · ${formatReadAgo(found.readAgoMs, m)}`;
        const base = row.current
          ? t("In use")
          : row.exhaustedUntil !== null
            ? t("Out of quota until {time}", {
                time: formatAntigravityReset(row.exhaustedUntil, locale),
              })
            : t("Saved");
        const status = left === null ? base : `${base} · ${left}`;
        return (
          <View key={row.id} className="min-h-14 flex-row items-center gap-3 px-4 py-2">
            <Pressable
              accessibilityRole="button"
              onPress={() => setRevealed((current) => (current === row.id ? null : row.id))}
              className="min-w-0 shrink grow gap-0.5"
            >
              <Text textRole="body" className="text-foreground" numberOfLines={1}>
                {shown(row)}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {status}
              </Text>
            </Pressable>
            {pending ? (
              <View className="h-11 w-11 items-center justify-center">
                <AppActivityIndicator colorClassName="accent-icon" />
              </View>
            ) : canManage ? (
              <Menu
                accessible
                accessibilityRole="button"
                accessibilityLabel={label(row)}
                title={label(row)}
                actions={actions}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "use") {
                    confirm(
                      row,
                      select,
                      t(
                        "Use {account}? Running threads on this instance stop, and new turns use this account.",
                        { account: label(row) },
                      ),
                      t("Use"),
                      false,
                    );
                  } else if (nativeEvent.event === "remove") {
                    confirm(
                      row,
                      remove,
                      t(
                        "Remove {account}? Running threads on this instance stop. Sign in again to add it back.",
                        { account: label(row) },
                      ),
                      t("Remove"),
                      true,
                    );
                  }
                }}
              >
                <ControlPill icon="ellipsis" accessibilityLabel={label(row)} />
              </Menu>
            ) : null}
          </View>
        );
      })}
      {error ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
