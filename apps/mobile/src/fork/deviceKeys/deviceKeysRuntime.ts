// fork: what the phone provides so `t3x-device` connections can sign in (design Q3, Q10). The phone
// holds its own device key, signs the pass itself, and reads the computer list it last fetched
// from the registry it joined. Without either, a device connection is blocked, never rerouted.
import {
  DeviceEnvironmentIndex,
  DeviceKeyAuthorization,
  deviceConnectionBlocked,
  deviceListNotReady,
  makeDeviceEnvironmentIndex,
} from "@t3tools/client-runtime/fork/deviceKeys/DeviceKeyAuthorization";
import type { DeviceDirectoryView } from "@t3tools/client-runtime/fork/deviceKeys/discovery";
import {
  makeDeviceKeyAuthorization,
  makePeerWaitStore,
  type DeviceAuthorizationSource,
} from "@t3tools/client-runtime/fork/deviceKeys/liveAuthorization";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

/** Environments waiting for another computer to learn about this phone; the devices page shows them. */
export const peerWait = makePeerWaitStore();
export const deviceEnvironmentIndex = makeDeviceEnvironmentIndex({ failClosedUntilBound: true });

// The store imports the connection runtime, which imports this layer, so it is loaded on first use.
const loadStore = Effect.promise(() => import("./deviceKeysStore"));

const source: DeviceAuthorizationSource = {
  directory: Effect.flatMap(
    loadStore,
    (store): Effect.Effect<DeviceDirectoryView, ReturnType<typeof deviceListNotReady>> => {
      const view = store.deviceSync.currentView();
      return view === null ? Effect.fail(deviceListNotReady()) : Effect.succeed(view);
    },
  ),
  signAssertion: (input) =>
    Effect.flatMap(loadStore, (store) => {
      const pass = store.deviceSync.signPass(input);
      return pass === null
        ? Effect.fail(
            deviceConnectionBlocked("This phone has not joined a server.", "authentication"),
          )
        : Effect.succeed(pass);
    }),
  // A computer that stops accepting this phone is the first sign it was removed: ask the registry
  // now, so the phone shows "removed" without waiting for the next foreground refresh.
  passRefused: () => {
    Effect.runFork(
      Effect.flatMap(loadStore, (store) =>
        Effect.promise(() => store.deviceSync.refresh({ force: true })),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not refresh the device list after a refused pass.", { cause }),
        ),
      ),
    );
  },
};

export const layer = Layer.merge(
  Layer.succeed(DeviceEnvironmentIndex, deviceEnvironmentIndex),
  Layer.effect(
    DeviceKeyAuthorization,
    Effect.gen(function* () {
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      const httpClient = yield* HttpClient.HttpClient;
      return makeDeviceKeyAuthorization({
        signer,
        httpClient,
        source,
        index: deviceEnvironmentIndex,
        wait: peerWait,
      });
    }),
  ),
);
