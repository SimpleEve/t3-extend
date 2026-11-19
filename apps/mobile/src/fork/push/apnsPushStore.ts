import Constants from "expo-constants";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { apnsSupport, type ApnsEnvironmentStatus, type ApnsSupport } from "./apnsPushModel";

// fork: what the iPhone push settings show. Holds states, never the token.

export interface ApnsPushUiState {
  readonly support: ApnsSupport;
  readonly enabled: boolean;
  readonly permission: "unknown" | "granted" | "denied";
  /** Apple gave no token: usually a build without the Push Notifications capability. */
  readonly tokenFailed: boolean;
  readonly environments: ReadonlyArray<ApnsEnvironmentStatus>;
}

/** Fixed for the life of the build: Apple grants push to paid accounts only. */
export const APNS_SUPPORT: ApnsSupport = apnsSupport({
  platform: Platform.OS,
  personalTeamBuild: Constants.expoConfig?.extra?.iosPersonalTeamBuild,
});

const listeners = new Set<() => void>();
let snapshot: ApnsPushUiState = {
  support: APNS_SUPPORT,
  enabled: false,
  permission: "unknown",
  tokenFailed: false,
  environments: [],
};

export function updateApnsPushState(patch: Partial<Omit<ApnsPushUiState, "support">>): void {
  const next = { ...snapshot, ...patch };
  const changed = (Object.keys(next) as Array<keyof ApnsPushUiState>).some(
    (key) => next[key] !== snapshot[key],
  );
  if (!changed) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getApnsPushState(): ApnsPushUiState {
  return snapshot;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useApnsPushState(): ApnsPushUiState {
  return useSyncExternalStore(subscribe, getApnsPushState, getApnsPushState);
}
