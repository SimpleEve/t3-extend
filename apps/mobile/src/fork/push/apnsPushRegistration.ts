import { getUiLocale, subscribeUiLocale } from "@t3tools/client-runtime/i18n";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ApnsPushRegistrationInput,
  EnvironmentId,
  PushDeliveryOutcome,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { requestAgentNotificationPermission } from "../../features/agent-awareness/notificationPermissions";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import {
  serverTakesApns,
  alertTemplatesOf,
  classifyApnsFailure,
  makeApnsRegistrationInput,
  resolveApnsEnvironment,
  apnsRegistrationKey,
  type ApnsEnvironmentStatus,
  type ApnsFailureKind,
} from "./apnsPushModel";
import { APNS_SUPPORT, getApnsPushState, updateApnsPushState } from "./apnsPushStore";
import { pushEnvironment } from "./pushCommands";
import { buildPushTemplateSet } from "./pushTemplates";
import {
  environmentLabel,
  inLane,
  isConnected,
  withTimeout,
  type TestNotificationOutcome,
} from "./unifiedPushRegistration";

// fork: keeps this iPhone's native APNs token on every paired environment. Each environment
// pushes to Apple itself with its own key, so the one token is simply given to all of them.

const RPC_TIMEOUT_MS = 20_000;
const FORGET_TIMEOUT_MS = 4_000;
const TEST_TIMEOUT_MS = 30_000;
const SYNC_DEBOUNCE_MS = 250;
const SYNC_REPEAT_MS = 10 * 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const ENABLED_KEY = "t3x.apns-push.enabled";
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

interface Controller {
  readonly deviceId: () => Promise<string>;
  readonly requestSync: (force?: boolean) => void;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  /** Push is going off: drops what the controller holds and keeps in-flight results out of it. */
  readonly reset: () => void;
  /** Asks one environment to forget this phone, while no sync registers it again. */
  readonly forgetEnvironment: (environmentId: EnvironmentId) => Promise<void>;
  /** Environments that may hold this phone's registration, whatever the screen shows. */
  readonly registeredEnvironments: () => ReadonlyArray<EnvironmentId>;
  /** Says an environment has been asked to forget this phone. */
  readonly forgotten: (environmentIds: ReadonlyArray<EnvironmentId>) => void;
}

let active: Controller | null = null;

type RegisterOutcome =
  | { readonly ok: true; readonly lastDelivery: PushDeliveryOutcome | null }
  | { readonly ok: false; readonly failure: ApnsFailureKind };

const registerFailed = (error: unknown): RegisterOutcome => {
  const failure = classifyApnsFailure(error);
  // The tag only: a message could quote the request, and the token is a credential.
  console.warn("[push] iOS register failed:", failure, (error as { _tag?: string } | null)?._tag);
  return { ok: false, failure };
};

const registerOn = async (
  environmentId: EnvironmentId,
  input: ApnsPushRegistrationInput,
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

/** The native token, as Apple's hex string; null when the build cannot get one. */
const readDeviceToken = (): Promise<string | null> =>
  Notifications.getDevicePushTokenAsync().then(
    (token) => (token.type === "ios" && typeof token.data === "string" ? token.data : null),
    () => null,
  );

const retryable = (entry: ApnsEnvironmentStatus | undefined) =>
  entry?.state === "failed" &&
  entry.failure !== "rejected" &&
  entry.failure !== "invalid" &&
  entry.failure !== "not-configured" &&
  entry.failure !== "server-outdated";

/** App-lifetime: asks Apple for this phone's token and keeps every environment's copy current. */
export function installApnsPushRegistration(): () => void {
  if (APNS_SUPPORT !== "supported") return () => {};

  let disposed = false;
  let enabled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_BASE_MS;
  let retryNext = false;
  // Bumped when push goes off: a sync or request that began before it must not write state.
  let generation = 0;
  let running = false;
  let queued = false;
  let forceNext = false;
  let deviceIdPromise: Promise<string> | null = null;
  // The last registration each environment accepted; the same key means nothing to send.
  const sent = new Map<string, string>();
  const statuses = new Map<string, ApnsEnvironmentStatus>();
  // The registration each environment last failed on; only a retry or a forced sync repeats it.
  const failedKeys = new Map<string, string>();
  // Environments being asked to forget this phone: no sync registers them meanwhile.
  const closing = new Set<string>();
  // Environments that may hold a registration, from the moment one is sent: unlike `statuses` it
  // survives a missing token or a reset, so switching push off still reaches them.
  const held = new Set<string>();
  // What each environment's capabilities said last, to tell a change from an unrelated update.
  const takesSeen = new Map<string, boolean | null>();

  const deviceId = () =>
    (deviceIdPromise ??= loadOrCreateAgentAwarenessDeviceId().catch(
      () => "ephemeral-mobile-device",
    ));
  const publish = () => updateApnsPushState({ environments: [...statuses.values()] });

  // Without a session the request would wait for the grants and then fail as a missing scope, so
  // an environment is only asked once it is connected, and its connection coming up registers it.
  const takesApnsOf = (environmentId: string) =>
    serverTakesApns(
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId as EnvironmentId))
        ?.environment.capabilities,
    );
  const watched = new Map<string, () => void>();
  const watchEnvironment = (environmentId: string) => {
    if (watched.has(environmentId)) return;
    const stopState = appAtomRegistry.subscribe(
      environmentCatalog.stateAtom(environmentId as EnvironmentId),
      () => requestSync(),
    );
    // The capabilities can land after the connection does.
    const stopConfig = appAtomRegistry.subscribe(
      serverEnvironment.configValueAtom(environmentId as EnvironmentId),
      () => {
        // What it refused or skipped while its capabilities were unknown or different is open again.
        if (takesApnsOf(environmentId) !== takesSeen.get(environmentId)) {
          sent.delete(environmentId);
          failedKeys.delete(environmentId);
        }
        requestSync();
      },
    );
    watched.set(environmentId, () => {
      stopState();
      stopConfig();
    });
  };

  // A failure that may pass (offline, reconnecting, no token yet) is tried again with growing
  // gaps. Only an attempt that failed moves the gap; a sync with nothing to retry leaves a
  // pending retry be.
  const settleRetry = (attemptFailed: boolean, needsRetry: boolean) => {
    if (!needsRetry) {
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
    takesSeen.clear();
  };

  const syncOnce = async (force: boolean, retryDue: boolean) => {
    if (!enabled) {
      reset();
      updateApnsPushState({ tokenFailed: false, permission: "unknown" });
      publish();
      return;
    }
    const gen = generation;
    const granted = await Notifications.getPermissionsAsync().then(
      (result) => result.granted,
      () => false,
    );
    const deviceToken = await readDeviceToken();
    if (gen !== generation) return;
    const bundleId = Constants.expoConfig?.ios?.bundleIdentifier?.trim();
    const tokenFailed = deviceToken === null || !bundleId;
    updateApnsPushState({ permission: granted ? "granted" : "denied", tokenFailed });
    if (tokenFailed) {
      // Nothing to hand out: what the environments hold is stale until a token arrives.
      statuses.clear();
      sent.clear();
      failedKeys.clear();
      takesSeen.clear();
      publish();
      settleRetry(true, true);
      return;
    }
    const label = Constants.deviceName?.trim() || "iPhone";
    const id = await deviceId();
    if (gen !== generation) return;
    const templates = alertTemplatesOf(buildPushTemplateSet(getUiLocale()));
    const apsEnvironment = resolveApnsEnvironment(Constants.expoConfig?.extra?.appVariant);
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const live = new Set<string>();
    let attemptFailed = false;
    await Promise.all(
      [...catalog.entries]
        .filter(([, entry]) => entry.enabled && entry.unsupportedReason === undefined)
        .map(async ([environmentId, entry]) => {
          live.add(environmentId);
          if (gen !== generation) return;
          watchEnvironment(environmentId);
          if (closing.has(environmentId)) return;
          const name = environmentLabel(entry);
          const input = makeApnsRegistrationInput({
            deviceId: id,
            deviceLabel: label,
            environmentLabel: name,
            deviceToken,
            apsEnvironment,
            bundleId,
            templates,
            notificationsEnabled: granted,
          });
          const key = apnsRegistrationKey(input);
          const previous = statuses.get(environmentId);
          // Before the caches below: what the server can do decides whether a skipped try is still right.
          const takesApns = takesApnsOf(environmentId);
          takesSeen.set(environmentId, takesApns);
          if (takesApns === false) {
            sent.delete(environmentId);
            failedKeys.delete(environmentId);
            if (previous?.failure !== "server-outdated") {
              statuses.set(environmentId, {
                environmentId,
                label: name,
                state: "failed",
                failure: "server-outdated",
                lastDelivery: null,
              });
              publish();
            }
            return;
          }
          if (!force && sent.get(environmentId) === key) return;
          if (
            !force &&
            failedKeys.get(environmentId) === key &&
            !(retryDue && retryable(previous))
          ) {
            return;
          }
          const waiting = (): ApnsEnvironmentStatus => ({
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
          held.add(environmentId);
          const result = await registerOn(environmentId as EnvironmentId, input);
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
            statuses.set(environmentId, {
              environmentId,
              label: name,
              state: "failed",
              failure: result.failure,
              lastDelivery: previous?.lastDelivery ?? null,
            });
            if (retryable(statuses.get(environmentId))) attemptFailed = true;
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
        held.delete(environmentId);
      }
    }
    for (const [environmentId, stop] of watched) {
      if (!live.has(environmentId)) {
        stop();
        watched.delete(environmentId);
      }
    }
    publish();
    settleRetry(attemptFailed, [...statuses.values()].some(retryable));
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
    setEnabled: async (value) => {
      enabled = value;
      updateApnsPushState({ enabled: value });
      await (
        value
          ? SecureStore.setItemAsync(ENABLED_KEY, "1", KEYCHAIN)
          : SecureStore.deleteItemAsync(ENABLED_KEY, KEYCHAIN)
      ).catch(() => undefined);
    },
    reset,
    forgetEnvironment: async (environmentId) => {
      closing.add(environmentId);
      try {
        await forgetOn(environmentId, await deviceId());
      } finally {
        closing.delete(environmentId);
        held.delete(environmentId);
        statuses.delete(environmentId);
        sent.delete(environmentId);
        failedKeys.delete(environmentId);
        publish();
      }
    },
    registeredEnvironments: () => [...held] as EnvironmentId[],
    forgotten: (environmentIds) => {
      for (const environmentId of environmentIds) held.delete(environmentId);
    },
  };

  void SecureStore.getItemAsync(ENABLED_KEY, KEYCHAIN).then(
    (stored) => {
      if (disposed || stored !== "1") return;
      enabled = true;
      updateApnsPushState({ enabled: true });
      requestSync(true);
    },
    () => undefined,
  );
  // A token Apple replaces, a new language (the alert wording travels with the registration) and
  // a permission changed in iOS Settings all reach every environment.
  const tokenSubscription = Notifications.addPushTokenListener(() => requestSync());
  const removeLocale = subscribeUiLocale(() => requestSync());
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") requestSync(true);
  });
  const removeCatalog = appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, () =>
    requestSync(),
  );
  // A server may have lost its registration (a restore, a manual edit); this heals it.
  const repeat = setInterval(() => requestSync(true), SYNC_REPEAT_MS);

  return () => {
    disposed = true;
    clearTimeout(timer);
    clearInterval(repeat);
    reset();
    tokenSubscription.remove();
    removeLocale();
    appState.remove();
    removeCatalog();
    active = null;
  };
}

export type EnableApnsPushResult = "enabled" | "permission-denied" | "unsupported";

/** Turns push on: asks for the notification permission first, then lets the sync do the rest. */
export async function enableApnsPush(): Promise<EnableApnsPushResult> {
  const controller = active;
  if (controller === null) return "unsupported";
  const granted = await Effect.runPromise(requestAgentNotificationPermission).then(
    (result) => result.type === "granted",
    () => false,
  );
  if (!granted) return "permission-denied";
  await controller.setEnabled(true);
  controller.requestSync(true);
  return "enabled";
}

/** Asks every environment to forget this phone, then stops registering it. */
export async function disableApnsPush(): Promise<void> {
  const controller = active;
  if (controller === null) return;
  // Not what the screen shows: a missing token empties that while the servers keep the phone.
  const known = controller.registeredEnvironments();
  // First, so a sync or registration already under way cannot write state or add to the server
  // after this; the unregisters then queue behind any request still in flight.
  controller.reset();
  await controller.setEnabled(false);
  if (known.length > 0) {
    const id = await controller.deviceId();
    await Promise.all(known.map((environmentId) => forgetOn(environmentId, id)));
    controller.forgotten(known);
  }
  updateApnsPushState({ environments: [], tokenFailed: false });
}

/** Try again after a failed token or registration. */
export function retryApnsPush(): void {
  active?.requestSync(true);
}

/**
 * Called before an environment is removed or switched off, while it can still be reached: the
 * phone cannot talk to it afterwards. Best effort; a revoked session ends it on the server anyway.
 */
export async function forgetApnsRegistration(environmentId: EnvironmentId): Promise<void> {
  const controller = active;
  if (controller === null || !getApnsPushState().enabled) return;
  await controller.forgetEnvironment(environmentId);
}

export async function sendApnsTestNotification(
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
