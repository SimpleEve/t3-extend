// fork: keeps the phone's saved computers in step with the server it joined. It reads the stored
// membership once at launch and checks the registry when the app returns to the foreground, at
// most every thirty seconds. Nothing polls in the background, and a phone that never joined does
// nothing here but read two keychain items.
import { AppState } from "react-native";

import { deviceSync } from "./deviceKeysStore";

export function installDeviceKeysSync(): () => void {
  void deviceSync.load().then(() => deviceSync.refresh({ force: true }));
  const subscription = AppState.addEventListener("change", (status) => {
    if (status !== "active") return;
    // A launch while the phone was locked could not read the keychain; the next foreground does.
    const retry =
      deviceSync.state()._tag === "storage-error" ? deviceSync.load() : Promise.resolve();
    void retry.then(() => deviceSync.refresh());
  });
  return () => subscription.remove();
}
