// fork: starts the device sync for the desktop app's own server (design Q10). It mounts once, with
// the app, and does nothing unless this computer has joined a server.
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { startDeviceKeysSync } from "./deviceKeysStore";

export function DeviceKeysSync() {
  const environmentId = usePrimaryEnvironmentId();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows an external subscription for as long as the app runs
  useEffect(
    () =>
      environmentId === null || window.desktopBridge === undefined
        ? undefined
        : startDeviceKeysSync(environmentId),
    [environmentId],
  );
  return null;
}
