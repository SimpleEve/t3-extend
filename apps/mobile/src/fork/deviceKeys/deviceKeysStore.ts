// fork: the phone's one membership, wired to the keychain, the network and the connection stack.
// The rules live in deviceSync.ts; this file only plugs the real things in.
import { reconcileDeviceEnvironments } from "@t3tools/client-runtime/fork/deviceKeys/deviceEnvironmentSync";
import { createRuntimeCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Crypto from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import type { SecretStore } from "./deviceKey";
import { createDeviceSync, type DeviceSyncState } from "./deviceSync";

const reconcile = createRuntimeCommand(connectionAtomRuntime, {
  label: "devices:reconcile",
  execute: reconcileDeviceEnvironments,
  concurrency: { mode: "serial", key: () => "devices" },
});

// The device key is this phone's identity, so it must not travel in a backup or to another phone.
// It is read at launch and when the app returns to the foreground, never from the background, so
// the stricter "when unlocked" class is enough. Every call uses the same options.
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const deviceSecretStore: SecretStore = {
  getItemAsync: (key) => SecureStore.getItemAsync(key, KEYCHAIN),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, KEYCHAIN),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, KEYCHAIN),
};

export const deviceSync = createDeviceSync({
  store: deviceSecretStore,
  registry: {
    // expo/fetch, not the global one: React Native's follows redirects whatever `redirect` says, and
    // a redirected request would carry the signed proof or the invite to another host. expo/fetch
    // stops at the 3xx on both platforms.
    // The body is bytes: expo/fetch sends any ArrayBufferView, though its BodyInit type omits them.
    fetch: (url, { body, ...init }) =>
      expoFetch(url, body === undefined ? init : { ...init, body: body as unknown as BodyInit }),
    randomBytes: Crypto.getRandomBytes,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  },
  applyView: async (view) => {
    await runAtomCommand(appAtomRegistry, reconcile, view, { reportFailure: false });
  },
});

export function useDeviceSyncState(): DeviceSyncState {
  return useSyncExternalStore(deviceSync.subscribe, deviceSync.state, deviceSync.state);
}
