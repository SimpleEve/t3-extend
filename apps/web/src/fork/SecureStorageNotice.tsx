// fork: Settings → Environments warning for a desktop whose system keychain refused this process or cannot open the saved catalog.
import { useEffect, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { useT } from "../hooks/useT";
import { isMacPlatform, isWindowsPlatform } from "../lib/utils";

type CatalogStatus = "available" | "unavailable" | "unreadable";

export function SecureStorageNotice() {
  const t = useT();
  const bridge = window.desktopBridge;
  const [status, setStatus] = useState<CatalogStatus>("available");
  const [restarting, setRestarting] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the Electron main process once when the section mounts
  useEffect(() => {
    void bridge?.getConnectionCatalogStatus?.().then(setStatus, () => setStatus("available"));
  }, [bridge]);

  if (bridge === undefined || status === "available") return null;
  const platform = bridge.getClientPlatform();
  const unreadable = status === "unreadable";
  const mac = isMacPlatform(platform);
  const windows = isWindowsPlatform(platform);
  const title = unreadable
    ? t("Saved connections could not be unlocked")
    : mac
      ? t("System keychain access not allowed")
      : windows
        ? t("System secure storage not available")
        : t("System keyring access not allowed");
  const body = unreadable
    ? mac
      ? t(
          "This app could not unlock its saved environments with its key in the macOS keychain, so they and computers from your server cannot be loaded. Quit and reopen the app. When macOS asks for keychain access, enter your login password and choose Always Allow.",
        )
      : windows
        ? t(
            "This app could not unlock its saved environments with the system secure storage, so they and computers from your server cannot be loaded. Restart the app to try again.",
          )
        : t(
            "This app could not unlock its saved environments with the system keyring, so they and computers from your server cannot be loaded. Unlock or start your keyring, then quit and reopen the app.",
          )
    : mac
      ? t(
          "This app could not access its key in the macOS keychain, so saved environments and computers from your server cannot be loaded or saved. Quit and reopen the app. When macOS asks for keychain access, enter your login password and choose Always Allow.",
        )
      : windows
        ? t(
            "This app could not access the system secure storage, so saved environments and computers from your server cannot be loaded or saved. Restart the app to try again.",
          )
        : t(
            "This app could not access the system keyring, so saved environments and computers from your server cannot be loaded or saved. Unlock or start your keyring, then quit and reopen the app.",
          );
  return (
    <Alert variant="warning">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
      {bridge.relaunchApp ? (
        <AlertAction>
          <Button
            size="xs"
            variant="outline"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              const enable = () => setRestarting(false);
              void bridge.relaunchApp?.().then((relaunched) => {
                if (!relaunched) enable();
              }, enable);
            }}
          >
            {t("Restart app")}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
