// fork: keeps the saved environments in step with the registry's computer list (design Q10, "保存与同步").
// Only environments this sync created are touched: they carry the `t3x-device` profile and a
// `t3x-device:<device id>` connection id. Environments the user added by hand are never removed.
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
} from "../../connection/catalog.ts";
import * as ConnectionCredentialStore from "../../connection/credentialStore.ts";
import { BearerConnectionTarget } from "../../connection/model.ts";
import * as EnvironmentRegistry from "../../connection/registry.ts";
import { fetchRemoteEnvironmentDescriptor } from "../../environment/descriptor.ts";
import {
  DeviceKeyAuthorization,
  deviceConnectionId,
  managedDeviceEnvironment,
  type ManagedDeviceEnvironment,
} from "./DeviceKeyAuthorization.ts";
import { checkComputerUrl, type DeviceDirectoryView } from "./discovery.ts";

const T3X_DEVICE = "t3x-device" as const;

/** Saved environments this sync owns. */
export const managedDeviceEnvironments = (
  entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
): ReadonlyArray<ManagedDeviceEnvironment> =>
  [...entries.values()].flatMap((entry) => managedDeviceEnvironment(entry) ?? []);

const toWebSocketBase = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

export const reconcileDeviceEnvironments = Effect.fn("deviceKeys.reconcileEnvironments")(function* (
  view: DeviceDirectoryView | null,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const authorization = yield* DeviceKeyAuthorization;
  const httpClient = yield* HttpClient.HttpClient;

  const managed = managedDeviceEnvironments(yield* SubscriptionRef.get(registry.entries));
  const byDevice = new Map(managed.map((entry) => [entry.deviceId, entry]));

  const wanted = new Map<string, { environmentId: EnvironmentId; url: string; name: string }>();
  for (const computer of view?.computers ?? []) {
    if (computer.self || computer.url === null || view === null) continue;
    const url = checkComputerUrl(view.pin, computer.url);
    if (url === null) continue;
    const known = byDevice.get(computer.deviceId);
    let environmentId: string | null = computer.environmentId;
    if (environmentId === null && !view.recordsEnvironmentIds) {
      // The list a desktop reads carries no environment ids, so the computer is asked once.
      environmentId =
        known?.url === url
          ? known.environmentId
          : yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: url }).pipe(
              Effect.map((descriptor) => descriptor.environmentId as string),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.orElseSucceed(() => null),
            );
    }
    if (environmentId === null) continue;
    wanted.set(computer.deviceId, {
      environmentId: EnvironmentId.make(environmentId),
      url,
      name: computer.name,
    });
  }

  const stillListed = new Set((view?.computers ?? []).map((computer) => computer.deviceId));
  const forget = (entry: ManagedDeviceEnvironment) =>
    authorization.forget(entry.environmentId).pipe(
      Effect.andThen(registry.remove(entry.environmentId)),
      Effect.catch((error) =>
        Effect.logWarning("Could not remove an environment that left your server.", { error }),
      ),
    );
  for (const entry of managed) {
    const next = wanted.get(entry.deviceId);
    // A computer still in the list keeps its entry while its address is missing or invalid.
    if (
      next === undefined
        ? !stillListed.has(entry.deviceId)
        : next.environmentId !== entry.environmentId
    ) {
      yield* forget(entry);
    }
  }

  for (const [deviceId, next] of wanted) {
    const connectionId = deviceConnectionId(deviceId);
    const existing = byDevice.get(deviceId);
    if (existing?.environmentId === next.environmentId && existing.url === next.url) continue;
    yield* registry
      .register(
        new BearerConnectionRegistration({
          target: new BearerConnectionTarget({
            environmentId: next.environmentId,
            label: next.name,
            connectionId,
          }),
          profile: new BearerConnectionProfile({
            connectionId,
            environmentId: next.environmentId,
            label: next.name,
            httpBaseUrl: next.url,
            wsBaseUrl: toWebSocketBase(next.url),
            authorization: T3X_DEVICE,
          }),
          // The registry insists on a credential; a device environment must not keep one.
          credential: new BearerConnectionCredential({ token: "" }),
        }),
      )
      .pipe(
        Effect.andThen(credentials.remove(connectionId)),
        Effect.catch((error) =>
          Effect.logWarning("Could not save an environment from your server.", { error }),
        ),
      );
  }
});

/**
 * Applies every view the platform feeds in; `null` means this device is not part of a server and
 * removes everything the sync saved. One view at a time.
 */
export const layerDeviceEnvironmentSync = <E, R>(
  views: Stream.Stream<DeviceDirectoryView | null, E, R>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const gate = yield* Semaphore.make(1);
      yield* views.pipe(
        Stream.runForEach((view) =>
          gate
            .withPermits(1)(reconcileDeviceEnvironments(view))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not sync environments from your server.", { cause }),
              ),
            ),
        ),
        Effect.catchCause((cause) => Effect.logWarning("The device list stream ended.", { cause })),
        Effect.forkScoped,
      );
    }),
  );
