// fork: the environments whose localhost forwarding this device turned off
// (research/remote-loopback-forwarding.md 10). Per device and per environment, like the sidebar
// fold state; it is not a client setting, so no contract changes and nothing is synced.
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

const STORAGE_KEY = "t3extend:loopback-gateway:v1";

interface DisabledGatewayState {
  readonly disabled: readonly string[];
}

const EMPTY: DisabledGatewayState = { disabled: [] };

export function parseDisabledGateway(raw: string | null): DisabledGatewayState {
  if (raw === null) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const { disabled } = parsed as Record<string, unknown>;
    return Array.isArray(disabled)
      ? { disabled: disabled.filter((id): id is string => typeof id === "string") }
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

function readPersisted(): DisabledGatewayState {
  try {
    return parseDisabledGateway(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY;
  }
}

export const useDisabledGatewayStore = create<DisabledGatewayState>(() =>
  typeof window === "undefined" ? EMPTY : readPersisted(),
);

export function setLoopbackForwardingDisabled(environmentId: EnvironmentId, disabled: boolean) {
  const { disabled: current } = useDisabledGatewayStore.getState();
  if (current.includes(environmentId) === disabled) return;
  const next = disabled
    ? [...current, environmentId]
    : current.filter((id) => id !== environmentId);
  useDisabledGatewayStore.setState({ disabled: next });
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ disabled: next }));
  } catch {}
}

export function useLoopbackForwardingDisabled(environmentId: EnvironmentId | null): boolean {
  return useDisabledGatewayStore(
    (state) => environmentId !== null && state.disabled.includes(environmentId),
  );
}
