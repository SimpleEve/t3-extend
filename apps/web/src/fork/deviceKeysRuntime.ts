// fork: what the desktop renderer provides so `t3x-device` connections can sign in (design Q3, Q10).
// The renderer holds no device key. A pass is signed by the computer's own server through the
// `devices.signAssertion` RPC, and the list of computers is the one that server last pushed.
import {
  DeviceEnvironmentIndex,
  DeviceKeyAuthorization,
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

/** Environments waiting for another computer to learn about this device; the Devices section shows them. */
export const peerWait = makePeerWaitStore();

// The store imports the connection runtime, which imports this layer, so it is loaded on first use.
const source: DeviceAuthorizationSource = {
  directory: Effect.flatMap(
    Effect.promise(() => import("./deviceKeysStore")),
    (store): Effect.Effect<DeviceDirectoryView, ReturnType<typeof deviceListNotReady>> => {
      const view = store.readDirectoryView();
      return view === null ? Effect.fail(deviceListNotReady()) : Effect.succeed(view);
    },
  ),
  signAssertion: (input) =>
    Effect.flatMap(
      Effect.promise(() => import("./deviceKeysStore")),
      (store) => store.signAssertionViaPrimary(input),
    ),
};

export const deviceEnvironmentIndex = makeDeviceEnvironmentIndex();

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
