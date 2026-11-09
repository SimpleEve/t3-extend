// A T3 home on disk as a join leaves it: device key, membership, device list and environment id.
// @effect-diagnostics nodeBuiltinImport:off -- Temp directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { redemptionOf } from "@t3tools/shared/forkDeviceKeys/invite";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";
import { fakeInvite } from "./deviceHarness.testkit.ts";
import { FakeRegistry, layerFakeRegistry } from "./registryFake.testkit.ts";

/** What a join leaves behind in a T3 home: the device key, membership, list and environment id. */
const layerSeed = (baseDir: string) => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
  const config = ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(platform),
  );
  const secrets = ServerSecretStore.layer.pipe(Layer.provide(config), Layer.provide(platform));
  const environment = ServerEnvironment.layerIdentity.pipe(
    Layer.provide(secrets),
    Layer.provide(config),
    Layer.provide(platform),
  );
  return DeviceKeysService.layer.pipe(
    Layer.provideMerge(DeviceDirectory.layer),
    Layer.provideMerge(DeviceIdentity.layer),
    Layer.provideMerge(layerFakeRegistry),
    Layer.provideMerge(
      Layer.succeed(SessionStore.SessionStore, {
        listActive: () => Effect.succeed([]),
        revoke: () => Effect.succeed(false),
        announceRevoked: () => Effect.succeed(0),
      } as unknown as SessionStore.SessionStore["Service"]),
    ),
    Layer.provideMerge(environment),
    Layer.provideMerge(secrets),
  );
};

export const seedHome = (baseDir: string) =>
  Effect.gen(function* () {
    const fake = yield* FakeRegistry;
    const service = yield* DeviceKeysService.DeviceKeysService;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const invite = fakeInvite("computer", now + 900);
    fake.state.invite = redemptionOf(invite.invite);
    const status = yield* service.join({ invite: invite.text, name: "Studio" });
    const laptop = fake.addDevice({
      kind: "computer",
      name: "Laptop",
      environmentId: "env-laptop",
    });
    yield* service.refresh;
    return {
      environmentId: yield* environment.getEnvironmentId,
      tunnelOrigin: status.url ?? "",
      laptop,
    };
  }).pipe(Effect.provide(layerSeed(baseDir)));

export const homeDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-tunnel-e2e-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);
