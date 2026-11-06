// fork: what this device remembers about forwarding a remote environment's localhost
// (research/remote-loopback-forwarding.md 2.3, 10): the environments the user turned it off for, and
// the ones it was last working for. Per device, like the sidebar fold state; it is not a client
// setting, so no contract changes and nothing is synced.
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

const STORAGE_KEY = "t3extend:loopback-gateway:v1";

interface GatewayStorage {
  /** Environments the user stopped forwarding for. */
  readonly disabled: readonly string[];
  /**
   * Environments whose forwarding was `active` the last time anything was known. After a restart a
   * tab of one of them must not load this computer's own `localhost` while the environment is out
   * of reach, so its webview waits (`isLoopbackGatewayReady`).
   */
  readonly wasActive: readonly string[];
}

const EMPTY: GatewayStorage = { disabled: [], wasActive: [] };

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/** Reads both lists; data written before `wasActive` existed has none. */
export function parseGatewayStorage(raw: string | null): GatewayStorage {
  if (raw === null) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const { disabled, wasActive } = parsed as Record<string, unknown>;
    return { disabled: strings(disabled), wasActive: strings(wasActive) };
  } catch {
    return EMPTY;
  }
}

function readPersisted(): GatewayStorage {
  try {
    return parseGatewayStorage(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY;
  }
}

export const useGatewayStorage = create<GatewayStorage>(() =>
  typeof window === "undefined" ? EMPTY : readPersisted(),
);

function commit(next: GatewayStorage) {
  useGatewayStorage.setState(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
}

const toggled = (list: readonly string[], id: string, present: boolean) =>
  present ? (list.includes(id) ? list : [...list, id]) : list.filter((entry) => entry !== id);

export function setLoopbackForwardingDisabled(environmentId: EnvironmentId, disabled: boolean) {
  const current = useGatewayStorage.getState();
  const disabledList = toggled(current.disabled, environmentId, disabled);
  if (disabledList !== current.disabled) commit({ ...current, disabled: disabledList });
}

export function setLoopbackWasActive(environmentId: string, wasActive: boolean) {
  const current = useGatewayStorage.getState();
  const list = toggled(current.wasActive, environmentId, wasActive);
  if (list.length !== current.wasActive.length) commit({ ...current, wasActive: list });
}

/** Forgets both records of the environments that are no longer saved in the app. */
export function pruneLoopbackForwardingRecords(knownEnvironmentIds: ReadonlySet<string>) {
  const current = useGatewayStorage.getState();
  const known = (id: string) => knownEnvironmentIds.has(id);
  const disabled = current.disabled.filter(known);
  const wasActive = current.wasActive.filter(known);
  if (
    disabled.length !== current.disabled.length ||
    wasActive.length !== current.wasActive.length
  ) {
    commit({ disabled, wasActive });
  }
}

export function useLoopbackForwardingDisabled(environmentId: EnvironmentId | null): boolean {
  return useGatewayStorage(
    (state) => environmentId !== null && state.disabled.includes(environmentId),
  );
}

export function useLoopbackWasActive(environmentId: EnvironmentId | null): boolean {
  return useGatewayStorage(
    (state) => environmentId !== null && state.wasActive.includes(environmentId),
  );
}
