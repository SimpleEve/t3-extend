// fork: the phone's one membership, wired to the keychain, the network and the connection stack.
// The rules live in deviceSync.ts; this file only plugs the real things in.
import { reconcileDeviceEnvironments } from "@t3tools/client-runtime/fork/deviceKeys/deviceEnvironmentSync";
import { createRuntimeCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { createDeviceSync, type DeviceSyncState } from "./deviceSync";

const reconcile = createRuntimeCommand(connectionAtomRuntime, {
  label: "devices:reconcile",
  execute: reconcileDeviceEnvironments,
  concurrency: { mode: "serial", key: () => "devices" },
});

export const deviceSync = createDeviceSync({
  store: SecureStore,
  registry: {
    fetch: (input, init) => fetch(input, init),
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
