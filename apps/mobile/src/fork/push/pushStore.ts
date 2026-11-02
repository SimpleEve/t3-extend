import { useSyncExternalStore } from "react";

import type { EnvironmentPushStatus, UnifiedPushUiState } from "./pushRegistrationModel";
import { NO_NATIVE_STATE, readUnifiedPushState, supportsUnifiedPush } from "./unifiedPushNative";

// fork: what the notification settings show. Holds hosts and states, never the endpoint.

const listeners = new Set<() => void>();
let environments: ReadonlyArray<EnvironmentPushStatus> = [];
let snapshot: UnifiedPushUiState = {
  supported: supportsUnifiedPush(),
  native: NO_NATIVE_STATE,
  environments,
};

function sameNative(a: UnifiedPushUiState["native"], b: UnifiedPushUiState["native"]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Re-reads the native side and publishes only if something changed, so renders stay quiet. */
export function refreshPushStore(): UnifiedPushUiState {
  const native = readUnifiedPushState();
  if (!sameNative(snapshot.native, native) || snapshot.environments !== environments) {
    snapshot = { supported: snapshot.supported, native, environments };
    for (const listener of listeners) listener();
  }
  return snapshot;
}

export function setPushEnvironments(next: ReadonlyArray<EnvironmentPushStatus>): void {
  environments = next;
  refreshPushStore();
}

export function getPushEnvironments(): ReadonlyArray<EnvironmentPushStatus> {
  return environments;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  refreshPushStore();
  return () => void listeners.delete(listener);
};
const getSnapshot = () => snapshot;

export function useUnifiedPushState(): UnifiedPushUiState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
