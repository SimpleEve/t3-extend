// fork: Settings → General switch for the background service (the packaged macOS app only).
import type { BackgroundServiceState } from "@t3tools/shared/backgroundService";
import { useEffect, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { useT } from "../hooks/useT";
import { getBackgroundServiceBridge } from "./backgroundServiceBridge";
import { backgroundServiceView } from "./backgroundService.logic";

export function BackgroundServiceSettings() {
  const t = useT();
  const bridge = getBackgroundServiceBridge();
  const [state, setState] = useState<BackgroundServiceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = () =>
    bridge?.getState().then(setState, () => setState({ kind: "attention", problem: "unreadable" }));
  const retry = () => {
    setBusy(true);
    void read()?.finally(() => setBusy(false));
  };
  const change = (enabled: boolean) => {
    setBusy(true);
    setError(null);
    void bridge
      ?.setEnabled(enabled)
      .then((result) => {
        setState(result.state);
        setError(result.error);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the launch agent's state from the Electron main process once
  useEffect(() => {
    void bridge
      ?.getState()
      .then(setState, () => setState({ kind: "attention", problem: "unreadable" }));
  }, [bridge]);

  const view = backgroundServiceView(state);
  if (bridge === undefined || view === null) return null;
  const status = {
    off: t("Off. Quitting the app also stops T3 Extend."),
    on: t("On. T3 Extend keeps running after you quit the app."),
    "app-missing": t(
      "The app this runs from was moved or deleted. Turn this off, then on again from the app's current location.",
    ),
    "needs-repair": t("Set up by another version of the app. Repair it so it runs this version."),
    "other-home": t(
      "A background service for another data folder is already installed on this computer. Remove it from a terminal first.",
    ),
    unreadable: t("Could not read the background service's state."),
  }[view.status];

  return (
    <SettingsSection id="background-service" title="Background running">
      <SettingsRow
        title={t("Keep running in the background")}
        description={t(
          "Keeps T3 Extend running after you quit the app, so your phone stays connected and notifications keep arriving. The app stops it while the app is open and starts it again when you quit.",
        )}
        status={
          <>
            {status}
            {error === null ? null : (
              <span className="block text-destructive">
                {t("Could not change it: {error}", { error })}
              </span>
            )}
          </>
        }
        control={
          <div className="flex items-center gap-2">
            {view.action === null ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => (view.action === "repair" ? change(true) : retry())}
              >
                {view.action === "repair" ? t("Repair") : t("Retry")}
              </Button>
            )}
            <Switch
              checked={view.checked}
              disabled={busy}
              onCheckedChange={(checked) => change(Boolean(checked))}
              aria-label={t("Keep running in the background")}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
