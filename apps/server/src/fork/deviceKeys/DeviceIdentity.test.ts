// @effect-diagnostics nodeBuiltinImport:off -- File modes are the point of the permissions test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";

const layer = DeviceIdentity.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-device-identity-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect("creates the key once, reads it back after a restart, and keeps the file private", () =>
  Effect.gen(function* () {
    const identity = yield* DeviceIdentity.DeviceIdentity;
    assert.isTrue(Option.isNone(yield* identity.peek));
    const created = yield* identity.getOrCreate;
    assert.equal((yield* identity.getOrCreate).id, created.id);
    assert.equal(Option.getOrThrow(yield* identity.peek).id, created.id);

    // A second instance over the same directory is a restarted server.
    const restarted = yield* Layer.build(DeviceIdentity.layer);
    const again = yield* Effect.provide(
      DeviceIdentity.DeviceIdentity.pipe(Effect.flatMap((service) => service.peek)),
      restarted,
    );
    assert.equal(Option.getOrThrow(again).id, created.id);

    const { secretsDir } = yield* ServerConfig.ServerConfig;
    const file = NodePath.join(secretsDir, `${DeviceIdentity.DEVICE_KEY_SECRET}.bin`);
    assert.equal(NodeFS.statSync(file).mode & 0o777, 0o600);
    assert.equal(NodeFS.statSync(secretsDir).mode & 0o777, 0o700);
    assert.notInclude(NodeFS.readFileSync(file, "utf8"), created.id);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("refuses to replace a damaged key, and starts over only after it is removed", () =>
  Effect.gen(function* () {
    const identity = yield* DeviceIdentity.DeviceIdentity;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const original = yield* identity.getOrCreate;
    for (const garbage of ["", "not json", '{"v":1,"d":"short"}', '{"v":2,"d":"x"}']) {
      yield* secrets.set(DeviceIdentity.DEVICE_KEY_SECRET, new TextEncoder().encode(garbage));
      const peeked = yield* identity.peek.pipe(Effect.flip);
      assert.equal(peeked._tag, "DeviceStoreError");
      assert.equal(peeked.problem, "corrupt");
      assert.equal((yield* identity.getOrCreate.pipe(Effect.flip)).problem, "corrupt");
    }
    yield* identity.remove;
    assert.isTrue(Option.isNone(yield* identity.peek));
    assert.notEqual((yield* identity.getOrCreate).id, original.id);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
