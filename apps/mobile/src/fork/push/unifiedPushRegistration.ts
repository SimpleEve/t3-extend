import { getUiLocale, subscribeUiLocale } from "@t3tools/client-runtime/i18n";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PushDeliveryOutcome,
  PushRegistrationInput,
  PushTestResult,
} from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";
import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { requestAgentNotificationPermission } from "../../features/agent-awareness/notificationPermissions";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { pushEnvironment } from "./pushCommands";
import {
  classifyPushFailure,
  distributorToAutoSelect,
  makePushRegistrationInput,
  PushRequestTimeout,
  registrationKey,
  type EnvironmentPushStatus,
  type PushFailureKind,
} from "./pushRegistrationModel";
import { getPushEnvironments, refreshPushStore, setPushEnvironments } from "./pushStore";
import { buildPushTemplates } from "./pushTemplates";
import {
  onUnifiedPushChange,
  readUnifiedPushState,
  readUnifiedPushSubscription,
  registerUnifiedPush,
  selectUnifiedPushDistributor,
  setUnifiedPushEnabled,
  setUnifiedPushTemplates,
  supportsUnifiedPush,
  unregisterUnifiedPush,
} from "./unifiedPushNative";

// fork: keeps this phone's UnifiedPush registration on every paired environment. Each
// environment pushes for its own threads, so the one endpoint is simply given to all of them.

const RPC_TIMEOUT_MS = 20_000;
const FORGET_TIMEOUT_MS = 4_000;
const TEST_TIMEOUT_MS = 30_000;
const SYNC_DEBOUNCE_MS = 250;
const SYNC_REPEAT_MS = 10 * 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

interface Controller {
  readonly deviceId: () => Promise<string>;
  readonly requestSync: (force?: boolean) => void;
  /** Lets the next sync ask the distributor for an endpoint again. */
  readonly forgetRequest: () => void;
  /** Push is going off: drops what the controller holds and keeps in-flight results out of it. */
  readonly reset: () => void;
  /** Asks one environment to forget this phone, while no sync registers it again. */
  readonly forgetEnvironment: (environmentId: EnvironmentId) => Promise<void>;
}

let active: Controller | null = null;

export const withTimeout = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PushRequestTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const lanes = new Map<string, Promise<void>>();

/**
 * One request at a time per environment, in order, shared by register and unregister, so an
 * unregister cannot be overtaken by the registration before it. The timeout only ends what the
 * caller waits for: the lane stays taken until the request itself ends, since the server can
 * still commit a request that timed out.
 */
export const inLane = <A>(
  environmentId: string,
  operation: () => Promise<A>,
  timeoutMs: number,
): Promise<A> => {
  const previous = lanes.get(environmentId) ?? Promise.resolve();
  let free: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    free = resolve;
  });
  lanes.set(environmentId, settled);
  void settled.then(() => {
    if (lanes.get(environmentId) === settled) lanes.delete(environmentId);
  });
  return previous.then(() => {
    const request = (async () => operation())();
    void request.then(free, free);
    return withTimeout(request, timeoutMs);
  });
};

type RegisterOutcome =
  | { readonly ok: true; readonly lastDelivery: PushDeliveryOutcome | null }
  | { readonly ok: false; readonly failure: PushFailureKind };

const registerFailed = (error: unknown): RegisterOutcome => {
  const failure = classifyPushFailure(error);
  // The tag only: a message could quote the request, and the endpoint is a credential.
  console.warn("[push] register failed:", failure, (error as { _tag?: string } | null)?._tag);
  return { ok: false, failure };
};

const registerOn = async (
  environmentId: EnvironmentId,
  input: PushRegistrationInput,
): Promise<RegisterOutcome> => {
  try {
    const result = await inLane(
      environmentId,
      () =>
        runAtomCommand(
          appAtomRegistry,
          pushEnvironment.register,
          { environmentId, input },
          COMMAND_OPTIONS,
        ),
      RPC_TIMEOUT_MS,
    );
    return result._tag === "Success"
      ? { ok: true, lastDelivery: result.value.lastDelivery?.outcome ?? null }
      : registerFailed(squashAtomCommandFailure(result));
  } catch (error) {
    return registerFailed(error);
  }
};

/**
 * Whether the environment has a live session right now, by the connection supervisor's own
 * state. Reads a mounted atom, so `watchEnvironment` must have subscribed to it first.
 */
export const isConnected = (environmentId: string): boolean =>
  AsyncResult.getOrElse(
    appAtomRegistry.get(environmentCatalog.stateAtom(environmentId as EnvironmentId)),
    () => null,
  )?.phase === "connected";

/** The scheme this build answers to; the receiver only honours the fork's own schemes. */
function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? FORK.scheme;
}

export function environmentLabel(entry: {
  readonly profile:
    | { readonly _tag: "Some"; readonly value: { readonly label: string } }
    | { readonly _tag: "None" };
}): string {
  return entry.profile._tag === "Some" ? entry.profile.value.label : "";
}

/** App-lifetime: registers with the distributor and keeps every environment's copy current. */
export function installUnifiedPushRegistration(): () => void {
  if (!supportsUnifiedPush()) return () => {};

  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_BASE_MS;
  let retryNext = false;
  // Bumped when push goes off: a sync or request that began before it must not write state.
  let generation = 0;
  let running = false;
  let queued = false;
  let forceNext = false;
  let requestedFor: string | null = null;
  let deviceIdPromise: Promise<string> | null = null;
  // The last registration each environment accepted; the same key means nothing to send.
  const sent = new Map<string, string>();
  const statuses = new Map<string, EnvironmentPushStatus>();
  // The registration each environment last failed on; only a retry or a forced sync repeats it.
  const failedKeys = new Map<string, string>();
  // Environments being asked to forget this phone: no sync registers them meanwhile.
  const closing = new Set<string>();

  const deviceId = () =>
    (deviceIdPromise ??= loadOrCreateAgentAwarenessDeviceId().catch(
      () => "ephemeral-mobile-device",
    ));
  const publish = () => setPushEnvironments([...statuses.values()]);

  // Without a session the request would wait six seconds for the grants and then fail as a
  // missing scope, so an environment is only asked once it is connected, and its connection
  // coming up (after a permission dialog, a network change, a restart) registers it.
  const watched = new Map<string, () => void>();
  const watchEnvironment = (environmentId: string) => {
    if (watched.has(environmentId)) return;
    watched.set(
      environmentId,
      appAtomRegistry.subscribe(environmentCatalog.stateAtom(environmentId as EnvironmentId), () =>
        requestSync(),
      ),
    );
  };

  const retryable = (entry: EnvironmentPushStatus | undefined) =>
    entry?.state === "failed" && entry.failure !== "rejected" && entry.failure !== "invalid";

  // A failed attempt that may pass (offline, reconnecting) is tried again with growing gaps, so
  // the registration does not wait for the next foreground or the ten-minute sweep. Only an
  // attempt that failed moves the gap; a sync with nothing to retry leaves a pending retry be.
  const settleRetry = (attemptFailed: boolean) => {
    if (![...statuses.values()].some(retryable)) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      retryDelay = RETRY_BASE_MS;
      return;
    }
    if (!attemptFailed && retryTimer !== undefined) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryNext = true;
      requestSync();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  };

  /** Everything the controller holds for the environments: push is off or has nothing to send. */
  const reset = () => {
    generation += 1;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retryDelay = RETRY_BASE_MS;
    retryNext = false;
    for (const stop of watched.values()) stop();
    watched.clear();
    statuses.clear();
    sent.clear();
    failedKeys.clear();
  };

  const syncOnce = async (force: boolean, retryDue: boolean) => {
    const native = readUnifiedPushState();
    refreshPushStore();
    if (!native.enabled) {
      reset();
      requestedFor = null;
      publish();
      return;
    }
    const auto = distributorToAutoSelect(native);
    if (auto !== null) selectUnifiedPushDistributor(auto);
    const distributor = native.distributor ?? auto;
    if (distributor === null) {
      reset();
      publish();
      return;
    }
    const subscription = readUnifiedPushSubscription();
    if (subscription === null) {
      reset();
      publish();
      // The distributor answers a registration with the endpoint, which fires onChange.
      if (requestedFor !== distributor) {
        requestedFor = distributor;
        registerUnifiedPush();
      }
      return;
    }
    const gen = generation;
    const permitted = await Notifications.getPermissionsAsync().then(
      (result) => result.granted,
      () => false,
    );
    if (gen !== generation) return;
    const label =
      Constants.deviceName?.trim() || (Platform.OS === "android" ? "Android device" : "Device");
    const id = await deviceId();
    if (gen !== generation) return;
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const live = new Set<string>();
    let attemptFailed = false;
    await Promise.all(
      [...catalog.entries]
        .filter(([, entry]) => entry.enabled && entry.unsupportedReason === undefined)
        .map(async ([environmentId, entry]) => {
          live.add(environmentId);
          watchEnvironment(environmentId);
          if (closing.has(environmentId)) return;
          const name = environmentLabel(entry);
          const input = makePushRegistrationInput({
            deviceId: id,
            deviceLabel: label,
            environmentLabel: name,
            subscription,
            notificationsEnabled: permitted,
          });
          const key = registrationKey(input);
          if (!force && sent.get(environmentId) === key) return;
          const previous = statuses.get(environmentId);
          if (
            !force &&
            failedKeys.get(environmentId) === key &&
            !(retryDue && retryable(previous))
          ) {
            return;
          }
          const waiting = (): EnvironmentPushStatus => ({
            environmentId,
            label: name,
            state: "waiting",
            lastDelivery: previous?.lastDelivery ?? null,
          });
          if (!isConnected(environmentId)) {
            if (previous?.state !== "registered") {
              statuses.set(environmentId, waiting());
              publish();
            }
            return;
          }
          statuses.set(environmentId, {
            environmentId,
            label: name,
            state: "pending",
            lastDelivery: previous?.lastDelivery ?? null,
          });
          publish();
          const result = await registerOn(environmentId, input);
          if (gen !== generation || closing.has(environmentId)) return;
          if (result.ok) {
            failedKeys.delete(environmentId);
            sent.set(environmentId, key);
            statuses.set(environmentId, {
              environmentId,
              label: name,
              state: "registered",
              lastDelivery: result.lastDelivery,
            });
          } else if (!isConnected(environmentId)) {
            // The connection went away under the request; its return registers it.
            sent.delete(environmentId);
            failedKeys.delete(environmentId);
            statuses.set(environmentId, waiting());
          } else {
            sent.delete(environmentId);
            failedKeys.set(environmentId, key);
            if (result.failure !== "rejected" && result.failure !== "invalid") attemptFailed = true;
            statuses.set(environmentId, {
              environmentId,
              label: name,
              state: "failed",
              failure: result.failure,
              lastDelivery: previous?.lastDelivery ?? null,
            });
          }
          publish();
        }),
    );
    if (gen !== generation) return;
    // Environments that went away end their registration with their session.
    for (const environmentId of statuses.keys()) {
      if (!live.has(environmentId)) {
        statuses.delete(environmentId);
        sent.delete(environmentId);
        failedKeys.delete(environmentId);
      }
    }
    for (const [environmentId, stop] of watched) {
      if (!live.has(environmentId)) {
        stop();
        watched.delete(environmentId);
      }
    }
    publish();
    settleRetry(attemptFailed);
  };

  const drain = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      do {
        queued = false;
        const force = forceNext;
        const retryDue = retryNext;
        forceNext = false;
        retryNext = false;
        await syncOnce(force, retryDue).catch(() => undefined);
      } while (queued && !disposed);
    } finally {
      running = false;
    }
  };

  const requestSync = (force = false) => {
    if (disposed) return;
    forceNext ||= force;
    clearTimeout(timer);
    timer = setTimeout(() => void drain(), SYNC_DEBOUNCE_MS);
  };

  active = {
    deviceId,
    requestSync,
    forgetRequest: () => {
      requestedFor = null;
    },
    reset,
    forgetEnvironment: async (environmentId) => {
      closing.add(environmentId);
      try {
        await forgetOn(environmentId, await deviceId());
      } finally {
        closing.delete(environmentId);
        statuses.delete(environmentId);
        sent.delete(environmentId);
        failedKeys.delete(environmentId);
        publish();
      }
    },
  };

  const pushTemplates = () =>
    setUnifiedPushTemplates(buildPushTemplates(getUiLocale()), appScheme());
  pushTemplates();
  const removeNative = onUnifiedPushChange(() => requestSync());
  // A new language reaches the receiver at once, so alerts follow it without JS running.
  const removeLocale = subscribeUiLocale(pushTemplates);
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") requestSync(true);
  });
  const removeCatalog = appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, () =>
    requestSync(),
  );
  // A server may have lost its registration (a restore, a manual edit); this heals it.
  const repeat = setInterval(() => requestSync(true), SYNC_REPEAT_MS);
  requestSync(true);

  return () => {
    disposed = true;
    clearTimeout(timer);
    clearInterval(repeat);
    reset();
    removeNative();
    removeLocale();
    appState.remove();
    removeCatalog();
    active = null;
  };
}

export type EnableUnifiedPushResult = "enabled" | "permission-denied";

/** Turns push on: asks for the notification permission first, then lets the sync do the rest. */
export async function enableUnifiedPush(): Promise<EnableUnifiedPushResult> {
  const permission = await Effect.runPromise(requestAgentNotificationPermission).then(
    (result) => result.type === "granted",
    () => false,
  );
  if (!permission) return "permission-denied";
  setUnifiedPushEnabled(true);
  refreshPushStore();
  active?.requestSync(true);
  return "enabled";
}

const forgetOn = async (environmentId: EnvironmentId, deviceId: string): Promise<void> => {
  await inLane(
    environmentId,
    () =>
      runAtomCommand(
        appAtomRegistry,
        pushEnvironment.unregister,
        { environmentId, input: { deviceId } },
        COMMAND_OPTIONS,
      ),
    FORGET_TIMEOUT_MS,
  ).catch(() => undefined);
};

/** Asks every environment to forget this phone, then gives the endpoint back to the distributor. */
export async function disableUnifiedPush(): Promise<void> {
  const controller = active;
  // A waiting environment was never asked, so there is nothing for it to forget.
  const known = getPushEnvironments()
    .filter((entry) => entry.state !== "waiting")
    .map((entry) => entry.environmentId as EnvironmentId);
  // First, so a sync or registration already under way cannot write state or add to the server
  // after this; the unregisters then queue behind any request still in flight.
  controller?.reset();
  setUnifiedPushEnabled(false);
  if (controller !== null && known.length > 0) {
    const id = await controller.deviceId();
    await Promise.all(known.map((environmentId) => forgetOn(environmentId, id)));
  }
  unregisterUnifiedPush();
  // Unregistering drops the saved distributor and the endpoint; switching on must ask again.
  controller?.forgetRequest();
  setPushEnvironments([]);
  refreshPushStore();
}

export function chooseUnifiedPushDistributor(distributor: string): void {
  selectUnifiedPushDistributor(distributor);
  refreshPushStore();
  // Picking again is also how a failed or lost registration is retried.
  active?.forgetRequest();
  active?.requestSync(true);
}

/**
 * Called before an environment is removed or switched off, while it can still be reached: the
 * phone cannot talk to it afterwards. Best effort; a revoked session ends it on the server anyway.
 */
export async function forgetPushRegistration(environmentId: EnvironmentId): Promise<void> {
  const controller = active;
  if (controller === null || !readUnifiedPushState().enabled) return;
  await controller.forgetEnvironment(environmentId);
}

export type TestNotificationOutcome =
  | { readonly kind: "result"; readonly result: PushTestResult }
  | { readonly kind: "unreachable" };

export async function sendTestNotification(
  environmentId: EnvironmentId,
): Promise<TestNotificationOutcome> {
  const controller = active;
  if (controller === null) return { kind: "unreachable" };
  const result = await withTimeout(
    runAtomCommand(
      appAtomRegistry,
      pushEnvironment.sendTest,
      { environmentId, input: { deviceId: await controller.deviceId() } },
      COMMAND_OPTIONS,
    ),
    TEST_TIMEOUT_MS,
  ).catch(() => null);
  return result?._tag === "Success"
    ? { kind: "result", result: result.value }
    : { kind: "unreachable" };
}
