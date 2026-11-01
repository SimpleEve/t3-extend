// fork: self-hosted connection. Desktop-only rows in Settings → Sharing & access.
import {
  normalizePublicUrl,
  type ManagedTunnelExit,
  type ManagedTunnelStatus,
} from "@t3tools/shared/selfHost";
import { PlusIcon, XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { getSelfHostBridge, updateSelfHost, useSelfHostState } from "~/fork/selfHostStore";
import { useT } from "~/hooks/useT";
import { refreshDesktopNetworkAccessState } from "~/state/desktopNetworkAccess";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { Translator } from "@t3tools/client-runtime/i18n";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

const STATUS_BADGE: Record<ManagedTunnelStatus, "outline" | "info" | "success" | "warning"> = {
  stopped: "outline",
  starting: "info",
  running: "success",
  "backing-off": "warning",
};

const statusLabel = (t: Translator, status: ManagedTunnelStatus): string => {
  switch (status) {
    case "stopped":
      return t("Stopped");
    case "starting":
      return t("Starting");
    case "running":
      return t("Running");
    case "backing-off":
      return t("Restarting");
  }
};

const exitLabel = (t: Translator, exit: ManagedTunnelExit): string => {
  switch (exit._tag) {
    case "spawn-failed":
      return t("Could not start the command.");
    case "exited":
      return t("The command exited with code {code}.", { code: exit.code });
    case "signaled":
      return t("The command was stopped by {signal}.", { signal: exit.signal });
  }
};

/** Accepts `t3.example.com` as shorthand for `https://t3.example.com`. */
const parseAddressInput = (value: string): string | null => {
  const trimmed = value.trim();
  return normalizePublicUrl(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
};

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

export function SelfHostSettings() {
  const t = useT();
  const { state, error } = useSelfHostState();
  const [addressDraft, setAddressDraft] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  // null: the field shows the saved command until the user edits it.
  const [commandDraft, setCommandDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (getSelfHostBridge() === undefined) return null;

  const run = (failureTitle: string, change: Parameters<typeof updateSelfHost>[0]) => {
    setPending(true);
    return updateSelfHost(change)
      .catch((cause: unknown) => reportFailure(failureTitle, cause))
      .finally(() => setPending(false));
  };

  const savePublicUrls = (urls: ReadonlyArray<string>) =>
    run(t("Could not save public addresses"), (bridge) => bridge.setPublicUrls(urls)).then(
      refreshDesktopNetworkAccessState,
    );

  const addAddress = (event: FormEvent) => {
    event.preventDefault();
    if (state === null) return;
    const url = parseAddressInput(addressDraft);
    if (url === null) {
      setAddressError(t("Enter an HTTPS address with no path, such as https://t3.example.com."));
      return;
    }
    setAddressError(null);
    setAddressDraft("");
    if (state.publicUrls.includes(url) || state.environmentPublicUrls.includes(url)) return;
    void savePublicUrls([...state.publicUrls, url]);
  };

  const tunnel = state?.tunnel ?? null;
  // An error line the command printed says more than how it ended.
  const tunnelProblem =
    tunnel?.lastError ?? (tunnel?.lastExit ? exitLabel(t, tunnel.lastExit) : null);
  const command = commandDraft ?? tunnel?.command ?? "";
  const commandChanged = tunnel !== null && command.trim() !== tunnel.command;
  const saveTunnel = (enabled: boolean) =>
    run(t("Could not update the tunnel"), (bridge) => bridge.setTunnel({ command, enabled })).then(
      () => setCommandDraft(null),
    );

  return (
    <>
      <SettingsRow
        id="self-host-public-addresses"
        title={t("Public addresses")}
        description={t(
          "HTTPS addresses that reach this computer through your own server, such as a reverse tunnel on a VPS. Devices you pair learn them and use them when they are away from your network.",
        )}
        status={error ? <span className="block text-destructive">{error}</span> : null}
      >
        <div className="space-y-2 pb-2">
          {state?.environmentPublicUrls.map((url) => (
            <div key={`env:${url}`} className="flex min-h-7 items-center gap-2 text-xs">
              <span className="min-w-0 truncate text-foreground">{url}</span>
              <Badge variant="outline" size="sm">
                {t("Set by environment")}
              </Badge>
            </div>
          ))}
          {state?.publicUrls.map((url) => (
            <div key={url} className="flex min-h-7 items-center gap-2 text-xs">
              <span className="min-w-0 truncate text-foreground">{url}</span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={t("Remove {address}", { address: url })}
                disabled={pending}
                onClick={() =>
                  void savePublicUrls(state.publicUrls.filter((saved) => saved !== url))
                }
              >
                <XIcon aria-hidden />
              </Button>
            </div>
          ))}
          <form className="flex items-center gap-2" onSubmit={addAddress}>
            <Input
              size="sm"
              value={addressDraft}
              placeholder="https://t3.example.com"
              aria-label={t("New public address")}
              aria-invalid={addressError !== null}
              onChange={(event) => {
                setAddressDraft(event.target.value);
                setAddressError(null);
              }}
            />
            <Button
              size="xs"
              variant="outline"
              type="submit"
              disabled={pending || state === null || addressDraft.trim() === ""}
            >
              <PlusIcon aria-hidden />
              {t("Add")}
            </Button>
          </form>
          {addressError ? <p className="text-xs text-destructive">{addressError}</p> : null}
        </div>
      </SettingsRow>
      <SettingsRow
        id="self-host-tunnel"
        title={t("Tunnel command")}
        description={t(
          "Optional. T3 Extend runs this command while the app is open, restarts it if it exits, and stops it when you quit. It runs on this computer as you, for example frpc -c ~/frpc.toml.",
        )}
        status={
          tunnel && (tunnel.enabled || tunnelProblem) ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant={STATUS_BADGE[tunnel.status]} size="sm">
                {statusLabel(t, tunnel.status)}
              </Badge>
              {tunnel.restarts > 0 ? (
                <span>{t("Restarted {count} times", { count: tunnel.restarts })}</span>
              ) : null}
              {tunnelProblem ? (
                <span className="block w-full break-all text-destructive">{tunnelProblem}</span>
              ) : null}
            </span>
          ) : null
        }
        control={
          <Switch
            checked={tunnel?.enabled ?? false}
            disabled={pending || tunnel === null || (!tunnel.enabled && command.trim() === "")}
            onCheckedChange={(checked) => void saveTunnel(checked)}
            aria-label={t("Run tunnel command")}
          />
        }
      >
        <div className="space-y-2 pb-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (commandChanged) void saveTunnel(tunnel?.enabled ?? false);
            }}
          >
            <Input
              size="sm"
              value={command}
              placeholder="frpc -c ~/frpc.toml"
              aria-label={t("Tunnel command")}
              spellCheck={false}
              onChange={(event) => setCommandDraft(event.target.value)}
            />
            <Button size="xs" variant="outline" type="submit" disabled={pending || !commandChanged}>
              {t("Save")}
            </Button>
            {tunnel?.enabled ? (
              <Button
                size="xs"
                variant="outline"
                type="button"
                disabled={pending}
                onClick={() =>
                  void run(t("Could not restart the tunnel"), (bridge) => bridge.restartTunnel())
                }
              >
                {t("Restart")}
              </Button>
            ) : null}
          </form>
          {tunnel && tunnel.recentOutput.length > 0 ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {t("Recent output")}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs whitespace-pre-wrap break-all">
                {tunnel.recentOutput.join("\n")}
              </pre>
            </details>
          ) : null}
        </div>
      </SettingsRow>
    </>
  );
}
