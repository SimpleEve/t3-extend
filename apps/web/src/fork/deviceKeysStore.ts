// fork: the Devices section's data and the sync that keeps saved environments in step with it.
// Everything here talks to this computer's own server through the `devices.*` RPCs; none of it
// runs in a plain browser, where those RPCs are refused.
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "@t3tools/client-runtime/connection";
import {
  deviceConnectionBlocked,
  deviceConnectionTransient,
} from "@t3tools/client-runtime/fork/deviceKeys/DeviceKeyAuthorization";
import { reconcileDeviceEnvironments } from "@t3tools/client-runtime/fork/deviceKeys/deviceEnvironmentSync";
import type { DeviceDirectoryView } from "@t3tools/client-runtime/fork/deviceKeys/discovery";
import {
  DeviceKeysError,
  FORK_DEVICE_KEYS_WS_METHODS,
  type DevicesSignAssertionInput,
  type DevicesSnapshot,
  type DevicesStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { networkAccessNeedsRefresh, snapshotToView } from "./deviceKeysLogic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { refreshDesktopNetworkAccessState } from "../state/desktopNetworkAccess";
import { readPrimaryEnvironmentId } from "../state/environments";

export const devicesStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:devices:status",
  tag: FORK_DEVICE_KEYS_WS_METHODS.status,
  staleTimeMs: 10_000,
  idleTtlMs: 30_000,
});

// One stream while anything reads it: the sync below, or the Devices section when it is open.
export const devicesSnapshot = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:devices:subscribe",
  tag: FORK_DEVICE_KEYS_WS_METHODS.subscribe,
  idleTtlMs: 30_000,
});

// Each write is one call at a time per computer, so two clicks never interleave.
const serial = {
  mode: "serial" as const,
  key: ({ environmentId }: { environmentId: string }) => environmentId,
};

export const devicesCommands = {
  join: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:devices:join",
    tag: FORK_DEVICE_KEYS_WS_METHODS.join,
    concurrency: serial,
  }),
  leave: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:devices:leave",
    tag: FORK_DEVICE_KEYS_WS_METHODS.leave,
    concurrency: serial,
  }),
  invite: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:devices:invite",
    tag: FORK_DEVICE_KEYS_WS_METHODS.invite,
    concurrency: serial,
  }),
  cancelInvite: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:devices:cancel-invite",
    tag: FORK_DEVICE_KEYS_WS_METHODS.cancelInvite,
    concurrency: serial,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:devices:remove",
    tag: FORK_DEVICE_KEYS_WS_METHODS.remove,
    concurrency: serial,
  }),
  rename: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:devices:rename",
    tag: FORK_DEVICE_KEYS_WS_METHODS.rename,
    concurrency: serial,
  }),
  setVisibility: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:devices:set-visibility",
    tag: FORK_DEVICE_KEYS_WS_METHODS.setVisibility,
    concurrency: serial,
  }),
};

const signAssertion = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:devices:sign-assertion",
  tag: FORK_DEVICE_KEYS_WS_METHODS.signAssertion,
});

const reconcile = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:devices:reconcile",
  execute: (view: DeviceDirectoryView | null) => reconcileDeviceEnvironments(view),
});

const isDeviceKeysError = Schema.is(DeviceKeysError);
const isAttemptError = Schema.is(Schema.Union([ConnectionBlockedError, ConnectionTransientError]));

/** Refreshes what the section shows after a write that changes who has joined. */
export function refreshDevicesStatus(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(devicesStatus({ environmentId, input: {} }));
}

let latest: DevicesSnapshot | null = null;

/** The computers this server last listed, as the connection code reads them. Null while not joined. */
export function readDirectoryView(): DeviceDirectoryView | null {
  return latest === null ? null : snapshotToView(latest);
}

const signFailure = (error: unknown): ConnectionAttemptError => {
  if (isAttemptError(error)) return error;
  if (!isDeviceKeysError(error)) {
    return deviceConnectionTransient("This computer's server could not sign in to that computer.");
  }
  switch (error.reason) {
    case "list_expired":
    case "unknown_audience":
    case "not_joined":
    case "not_local_owner":
      return deviceConnectionBlocked(error.message, "authentication");
    default:
      return deviceConnectionTransient(error.message);
  }
};

/** Asks this computer's own server for a pass to another computer. */
export function signAssertionViaPrimary(
  input: Pick<DevicesSignAssertionInput, "audienceEnvironmentId" | "dpopThumbprint">,
): Effect.Effect<string, ConnectionAttemptError> {
  const environmentId = readPrimaryEnvironmentId();
  if (environmentId === null) {
    return Effect.fail(deviceConnectionBlocked("This computer's own server is not connected."));
  }
  return Effect.promise(() =>
    runAtomCommand(
      appAtomRegistry,
      signAssertion,
      { environmentId, input },
      { reportFailure: false },
    ),
  ).pipe(
    Effect.flatMap((result) =>
      result._tag === "Success"
        ? Effect.succeed(result.value.assertion)
        : Effect.fail(signFailure(squashAtomCommandFailure(result))),
    ),
  );
}

const view = (result: AsyncResult.AsyncResult<DevicesSnapshot, unknown>) =>
  AsyncResult.value(result).pipe(Option.getOrNull);

/**
 * Keeps this app's saved environments in step with the server's device list, once this computer
 * has joined a server. The stream stays open after a leave: the tunnel going down is what tells
 * the Settings page its pairing addresses changed (`networkAccessNeedsRefresh`).
 */
export function startDeviceKeysSync(environmentId: EnvironmentId): () => void {
  const apply = (snapshot: DevicesSnapshot | null) => {
    latest = snapshot;
    void runAtomCommand(
      appAtomRegistry,
      reconcile,
      { environmentId, input: snapshot === null ? null : snapshotToView(snapshot) },
      { reportFailure: false },
    );
  };
  let stopSnapshots: (() => void) | null = null;
  let tunnel: DevicesStatus["tunnel"]["status"] | null = null;
  const noteTunnel = (status: DevicesStatus) => {
    if (networkAccessNeedsRefresh(tunnel, status.tunnel.status)) refreshDesktopNetworkAccessState();
    tunnel = status.tunnel.status;
  };
  const stopStatus = appAtomRegistry.subscribe(
    devicesStatus({ environmentId, input: {} }),
    (result) => {
      const status = AsyncResult.value(result).pipe(Option.getOrNull);
      if (status === null) return;
      noteTunnel(status);
      if (status.state === "joined") {
        stopSnapshots ??= appAtomRegistry.subscribe(
          devicesSnapshot({ environmentId, input: {} }),
          (snapshots) => {
            const snapshot = view(snapshots);
            if (snapshot === null) return;
            noteTunnel(snapshot.status);
            apply(snapshot);
          },
          { immediate: true },
        );
      } else {
        apply(null);
      }
    },
    { immediate: true },
  );
  return () => {
    stopStatus();
    stopSnapshots?.();
    latest = null;
  };
}

// The command palette asks the open Settings page to start an invite; the page takes it when it
// shows. A counter, not a flag, so asking twice opens the dialog twice.
let inviteRequests = 0;
const requestListeners = new Set<() => void>();

export function requestDeviceInvite(): void {
  inviteRequests += 1;
  for (const listener of requestListeners) listener();
}

export function useDeviceInviteRequests(): number {
  return useSyncExternalStore(
    (listener) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    () => inviteRequests,
    () => inviteRequests,
  );
}
