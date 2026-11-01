import type { AdvertisedEndpoint } from "@t3tools/contracts";
import {
  SELF_HOST_BRIDGE_GLOBAL,
  type SelfHostBridge,
  type SelfHostState,
} from "@t3tools/shared/selfHost";
import { useSyncExternalStore } from "react";

// fork: self-hosted connection. Only the desktop renderer has this bridge.
export function getSelfHostBridge(): SelfHostBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, SelfHostBridge | undefined>)[SELF_HOST_BRIDGE_GLOBAL];
}

let current: SelfHostState | null = null;
let loadError: string | null = null;
const listeners = new Set<() => void>();
let unsubscribeBridge: (() => void) | null = null;

function publish(next: SelfHostState | null, error: string | null): void {
  current = next;
  loadError = error;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const bridge = getSelfHostBridge();
  if (bridge !== undefined && unsubscribeBridge === null) {
    unsubscribeBridge = bridge.onState((state) => publish(state, null));
    void bridge
      .getState()
      .then((state) => publish(state, null))
      .catch((error: unknown) =>
        publish(current, error instanceof Error ? error.message : String(error)),
      );
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribeBridge !== null) {
      unsubscribeBridge();
      unsubscribeBridge = null;
    }
  };
}

const snapshot = () => current;
const errorSnapshot = () => loadError;

export function useSelfHostState(): {
  readonly state: SelfHostState | null;
  readonly error: string | null;
} {
  return {
    state: useSyncExternalStore(subscribe, snapshot, snapshot),
    error: useSyncExternalStore(subscribe, errorSnapshot, errorSnapshot),
  };
}

/** Applies a bridge call's returned state so the screen updates before the next push. */
export async function updateSelfHost(
  change: (bridge: SelfHostBridge) => Promise<SelfHostState>,
): Promise<void> {
  const bridge = getSelfHostBridge();
  if (bridge === undefined) return;
  publish(await change(bridge), null);
}

/** Endpoints desktop main builds from saved and environment public addresses. */
export const isSelfHostEndpoint = (endpoint: AdvertisedEndpoint): boolean =>
  endpoint.id.startsWith("self-host:");
