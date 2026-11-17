// fork: Settings → Environments warning for a desktop whose system keychain refused this process.
import { useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { useT } from "../hooks/useT";
import { isMacPlatform } from "../lib/utils";

export function SecureStorageNotice() {
  const t = useT();
  const bridge = window.desktopBridge;
  const [available, setAvailable] = useState(true);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the Electron main process once when the section mounts
  useEffect(() => {
    void bridge?.getConnectionCatalogAvailable?.().then(setAvailable, () => setAvailable(true));
  }, [bridge]);

  if (bridge === undefined || available) return null;
  const mac = isMacPlatform(bridge.getClientPlatform());
  return (
    <Alert variant="warning">
      <AlertTitle>{t("System keychain access not allowed")}</AlertTitle>
      <AlertDescription>
        {mac
          ? t(
              "This app could not access its key in the macOS keychain, so saved environments and computers from your server cannot be loaded or saved. Quit and reopen the app. When macOS asks for keychain access, enter your login password and choose Always Allow.",
            )
          : t(
              "This app could not access the system secure storage or keyring, so saved environments and computers from your server cannot be loaded or saved. Unlock or start your keyring, then quit and reopen the app.",
            )}
      </AlertDescription>
      {bridge.relaunchApp ? (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={() => void bridge.relaunchApp?.()}>
            {t("Restart app")}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
