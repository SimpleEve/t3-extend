import { getUiLocale, subscribeUiLocale } from "@t3tools/client-runtime/i18n";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PushTestResult } from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";
import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { requestAgentNotificationPermission } from "../../features/agent-awareness/notificationPermissions";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { pushEnvironment } from "./pushCommands";
import {
  distributorToAutoSelect,
  makePushRegistrationInput,
  registrationKey,
  type EnvironmentPushStatus,
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
const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

interface Controller {
  readonly deviceId: () => Promise<string>;
  readonly requestSync: (force?: boolean) => void;
}

let active: Controller | null = null;

const withTimeout = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
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

  const syncOnce = async (force: boolean) => {
    const native = readUnifiedPushState();
    refreshPushStore();
    if (!native.enabled) {
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
          statuses.set(environmentId, {
            environmentId,
            label: name,
            state: "pending",
            lastDelivery: previous?.lastDelivery ?? null,
          });
          publish();
          const result = await withTimeout(
            runAtomCommand(
              appAtomRegistry,
              pushEnvironment.register,
              { environmentId, input },
              COMMAND_OPTIONS,
            ),
            RPC_TIMEOUT_MS,
          ).catch(() => null);
          if (result?._tag === "Success") {
            sent.set(environmentId, key);
            statuses.set(environmentId, {
              environmentId,
              label: name,
              state: "registered",
              lastDelivery: result.value.lastDelivery?.outcome ?? null,
            });
          } else {
            sent.delete(environmentId);
            statuses.set(environmentId, {
              environmentId,
              label: name,
              state: "failed",
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
    publish();
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

  active = { deviceId, requestSync };

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
  const known = getPushEnvironments().map((entry) => entry.environmentId as EnvironmentId);
  if (controller !== null && known.length > 0) {
    const id = await controller.deviceId();
    await Promise.all(known.map((environmentId) => forgetOn(environmentId, id)));
  }
  setUnifiedPushEnabled(false);
  unregisterUnifiedPush();
  setPushEnvironments([]);
  refreshPushStore();
}

export function chooseUnifiedPushDistributor(distributor: string): void {
  selectUnifiedPushDistributor(distributor);
  refreshPushStore();
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
