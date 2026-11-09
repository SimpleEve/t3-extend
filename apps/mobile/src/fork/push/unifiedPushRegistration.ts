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
}

let active: Controller | null = null;

const withTimeout = <A>(promise: Promise<A>, ms: number): Promise<A> =>
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
    const result = await withTimeout(
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
const isConnected = (environmentId: string): boolean =>
  AsyncResult.getOrElse(
    appAtomRegistry.get(environmentCatalog.stateAtom(environmentId as EnvironmentId)),
    () => null,
  )?.phase === "connected";

/** The scheme this build answers to; the receiver only honours the fork's own schemes. */
function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? FORK.scheme;
}

function environmentLabel(entry: {
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
  let running = false;
  let queued = false;
  let forceNext = false;
  let requestedFor: string | null = null;
  let deviceIdPromise: Promise<string> | null = null;
  // The last registration each environment accepted; the same key means nothing to send.
  const sent = new Map<string, string>();
  const statuses = new Map<string, EnvironmentPushStatus>();

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

  // A failure that may pass (offline, reconnecting) is tried again with growing gaps, so the
  // registration does not wait for the next foreground or the ten-minute sweep.
  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    const retryable = [...statuses.values()].some(
      (entry) =>
        entry.state === "failed" && entry.failure !== "rejected" && entry.failure !== "invalid",
    );
    if (!retryable) {
      retryDelay = RETRY_BASE_MS;
      return;
    }
    retryTimer = setTimeout(() => requestSync(), retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  };

  const syncOnce = async (force: boolean) => {
    const native = readUnifiedPushState();
    refreshPushStore();
    if (!native.enabled) {
      clearTimeout(retryTimer);
      statuses.clear();
      sent.clear();
      requestedFor = null;
      publish();
      return;
    }
    const auto = distributorToAutoSelect(native);
    if (auto !== null) selectUnifiedPushDistributor(auto);
    const distributor = native.distributor ?? auto;
    if (distributor === null) return;
    const subscription = readUnifiedPushSubscription();
    if (subscription === null) {
      // The distributor answers a registration with the endpoint, which fires onChange.
      if (requestedFor !== distributor) {
        requestedFor = distributor;
        registerUnifiedPush();
      }
      return;
    }
    const permitted = await Notifications.getPermissionsAsync().then(
      (result) => result.granted,
      () => false,
    );
    const label =
      Constants.deviceName?.trim() || (Platform.OS === "android" ? "Android device" : "Device");
    const id = await deviceId();
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const live = new Set<string>();
    await Promise.all(
      [...catalog.entries]
        .filter(([, entry]) => entry.enabled && entry.unsupportedReason === undefined)
        .map(async ([environmentId, entry]) => {
          live.add(environmentId);
          watchEnvironment(environmentId);
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
          if (result.ok) {
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
            statuses.set(environmentId, waiting());
          } else {
            sent.delete(environmentId);
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
    // Environments that went away end their registration with their session.
    for (const environmentId of statuses.keys()) {
      if (!live.has(environmentId)) {
        statuses.delete(environmentId);
        sent.delete(environmentId);
      }
    }
    for (const [environmentId, stop] of watched) {
      if (!live.has(environmentId)) {
        stop();
        watched.delete(environmentId);
      }
    }
    publish();
    scheduleRetry();
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
        forceNext = false;
        await syncOnce(force).catch(() => undefined);
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
    clearTimeout(retryTimer);
    clearInterval(repeat);
    for (const stop of watched.values()) stop();
    watched.clear();
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
  await withTimeout(
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
  if (controller !== null && known.length > 0) {
    const id = await controller.deviceId();
    await Promise.all(known.map((environmentId) => forgetOn(environmentId, id)));
  }
  setUnifiedPushEnabled(false);
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
  await forgetOn(environmentId, await controller.deviceId());
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
