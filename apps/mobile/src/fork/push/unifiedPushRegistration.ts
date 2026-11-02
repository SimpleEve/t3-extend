import {
  EnvironmentRegistry,
  type EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { getUiLocale, subscribeUiLocale } from "@t3tools/client-runtime/i18n";
import { request } from "@t3tools/client-runtime/rpc";
import { FORK_PUSH_WS_METHODS, type EnvironmentId, type PushTestResult } from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AppState, Platform } from "react-native";

import * as MobileStorage from "../../persistence/mobile-storage";
import { requestAgentNotificationPermission } from "../../features/agent-awareness/notificationPermissions";
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

const RPC_TIMEOUT = "15 seconds";
const FORGET_TIMEOUT = "4 seconds";
const SYNC_DEBOUNCE = "250 millis";
const SYNC_REPEAT = "10 minutes";

interface Controller {
  readonly deviceId: string;
  readonly requestSync: (force?: boolean) => void;
  readonly runOn: <A, E>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>,
  ) => Promise<A>;
}

let active: Controller | null = null;

const environmentLabel = (entry: {
  readonly target: { readonly environmentId: EnvironmentId };
  readonly profile: Option.Option<{ readonly label: string }>;
}) => Option.match(entry.profile, { onNone: () => "", onSome: (profile) => profile.label });

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!supportsUnifiedPush()) return;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const storage = yield* MobileStorage.MobileStorage;
    const deviceId = yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
      Effect.orElseSucceed(() => "ephemeral-mobile-device"),
    );
    const deviceLabel =
      Constants.deviceName?.trim() || (Platform.OS === "android" ? "Android device" : "Device");
    const syncRequests = yield* Queue.sliding<boolean>(1);
    // The last registration each environment accepted; same key means nothing to send.
    const sent = new Map<string, string>();
    const statuses = new Map<string, EnvironmentPushStatus>();
    let requestedFor: string | null = null;
    let forceNext = false;

    const publish = () => setPushEnvironments([...statuses.values()]);
    const requestSync = (force = false) => {
      forceNext ||= force;
      Queue.offerUnsafe(syncRequests, force);
    };

    const sync = Effect.gen(function* () {
      const force = forceNext;
      forceNext = false;
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
      const permission = yield* Effect.promise(() => Notifications.getPermissionsAsync()).pipe(
        Effect.map((result) => result.granted),
        Effect.orElseSucceed(() => false),
      );
      const entries = yield* SubscriptionRef.get(registry.entries);
      const live = new Set<string>();
      yield* Effect.forEach(
        [...entries.entries()].filter(([, entry]) => entry.enabled),
        ([environmentId, entry]) => {
          live.add(environmentId);
          const label = environmentLabel(entry);
          const input = makePushRegistrationInput({
            deviceId,
            deviceLabel,
            environmentLabel: label,
            subscription,
            notificationsEnabled: permission,
          });
          const key = registrationKey(input);
          if (!force && sent.get(environmentId) === key) return Effect.void;
          const previous = statuses.get(environmentId);
          statuses.set(environmentId, {
            environmentId,
            label,
            state: "pending",
            lastDelivery: previous?.lastDelivery ?? null,
          });
          publish();
          return registry.run(environmentId, request(FORK_PUSH_WS_METHODS.register, input)).pipe(
            Effect.timeout(RPC_TIMEOUT),
            Effect.map((status) => {
              sent.set(environmentId, key);
              statuses.set(environmentId, {
                environmentId,
                label,
                state: "registered",
                lastDelivery: status.lastDelivery?.outcome ?? null,
              });
            }),
            Effect.catchCause(() =>
              Effect.sync(() => {
                sent.delete(environmentId);
                statuses.set(environmentId, {
                  environmentId,
                  label,
                  state: "failed",
                  lastDelivery: previous?.lastDelivery ?? null,
                });
              }),
            ),
            Effect.tap(() => Effect.sync(publish)),
          );
        },
        { concurrency: "unbounded", discard: true },
      );
      // Environments that went away are gone from the list; their registrations end with their session.
      for (const environmentId of statuses.keys()) {
        if (!live.has(environmentId)) {
          statuses.delete(environmentId);
          sent.delete(environmentId);
        }
      }
      publish();
    }).pipe(Effect.withSpan("mobile.unifiedPush.sync"), Effect.ignoreCause);

    active = {
      deviceId,
      requestSync,
      runOn: (environmentId, effect) => Effect.runPromise(registry.run(environmentId, effect)),
    };

    const pushTemplates = () =>
      setUnifiedPushTemplates(buildPushTemplates(getUiLocale()), FORK.scheme);

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        pushTemplates();
        const removeNative = onUnifiedPushChange(() => requestSync());
        // A new language reaches the receiver at once, so alerts follow it without JS running.
        const removeLocale = subscribeUiLocale(pushTemplates);
        const appState = AppState.addEventListener("change", (state) => {
          if (state === "active") requestSync(true);
        });
        return { removeNative, removeLocale, appState };
      }),
      ({ removeNative, removeLocale, appState }) =>
        Effect.sync(() => {
          removeNative();
          removeLocale();
          appState.remove();
          active = null;
        }),
    );
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach(() => Effect.sync(() => requestSync())),
      Effect.forkScoped,
    );
    yield* Stream.fromQueue(syncRequests).pipe(
      Stream.debounce(SYNC_DEBOUNCE),
      Stream.runForEach(() => sync),
      Effect.forkScoped,
    );
    // A server may have lost its registration (a restore, a manual edit); this heals it.
    yield* Effect.sync(() => requestSync(true)).pipe(
      Effect.repeat(Schedule.spaced(SYNC_REPEAT)),
      Effect.forkScoped,
    );
  }),
);

export type EnableUnifiedPushResult = "enabled" | "permission-denied";

/** Turns push on: asks for the notification permission first, then lets the sync do the rest. */
export async function enableUnifiedPush(): Promise<EnableUnifiedPushResult> {
  const permission = await Effect.runPromise(
    requestAgentNotificationPermission.pipe(
      Effect.map((result) => result.type === "granted"),
      Effect.orElseSucceed(() => false),
    ),
  );
  if (!permission) return "permission-denied";
  setUnifiedPushEnabled(true);
  refreshPushStore();
  active?.requestSync(true);
  return "enabled";
}

/** Asks every environment to forget this phone, then gives the endpoint back to the distributor. */
export async function disableUnifiedPush(): Promise<void> {
  const controller = active;
  const known = getPushEnvironments().map((entry) => entry.environmentId as EnvironmentId);
  if (controller !== null) {
    await Promise.all(known.map((environmentId) => forgetOn(controller, environmentId)));
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

const forgetOn = (controller: Controller, environmentId: EnvironmentId): Promise<void> =>
  controller
    .runOn(
      environmentId,
      request(FORK_PUSH_WS_METHODS.unregister, { deviceId: controller.deviceId }).pipe(
        Effect.timeout(FORGET_TIMEOUT),
      ),
    )
    .then(
      () => undefined,
      () => undefined,
    );

/**
 * Called before an environment is removed or switched off, while it can still be reached: the
 * phone cannot talk to it afterwards. Best effort; a revoked session ends it on the server anyway.
 */
export async function forgetPushRegistration(environmentId: EnvironmentId): Promise<void> {
  const controller = active;
  if (controller === null || !readUnifiedPushState().enabled) return;
  await forgetOn(controller, environmentId);
}

export type TestNotificationOutcome =
  | { readonly kind: "result"; readonly result: PushTestResult }
  | { readonly kind: "unreachable" };

export async function sendTestNotification(
  environmentId: EnvironmentId,
): Promise<TestNotificationOutcome> {
  const controller = active;
  if (controller === null) return { kind: "unreachable" };
  return controller
    .runOn(
      environmentId,
      request(FORK_PUSH_WS_METHODS.sendTest, { deviceId: controller.deviceId }).pipe(
        Effect.timeout("30 seconds"),
      ),
    )
    .then(
      (result): TestNotificationOutcome => ({ kind: "result", result }),
      (): TestNotificationOutcome => ({ kind: "unreachable" }),
    );
}
