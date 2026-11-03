import { it, expect } from "@effect/vitest";
import {
  DeviceEnvironmentIndex,
  refuseRelayForDeviceEnvironment,
} from "@t3tools/client-runtime/fork/deviceKeys/DeviceKeyAuthorization";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

import * as DeviceKeys from "./deviceKeysRuntime";

const dependencies = Layer.mergeAll(
  Layer.succeed(
    ManagedRelay.ManagedRelayDpopSigner,
    ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("thumbprint"),
      createProof: () => Effect.succeed("proof"),
    }),
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("no request expected")),
  ),
);

it.effect(
  "provides an index that refuses every relay until the registry has bound its directory",
  () =>
    Effect.gen(function* () {
      const index = yield* DeviceEnvironmentIndex;
      expect(index).toBe(DeviceKeys.deviceEnvironmentIndex);
      const refused = yield* refuseRelayForDeviceEnvironment("environment-1").pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "ConnectionTransientError", hop: "device" });
    }).pipe(Effect.provide(DeviceKeys.layer.pipe(Layer.provide(dependencies)))),
);
