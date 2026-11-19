// @effect-diagnostics nodeBuiltinImport:off -- The test generates a receiver key pair.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfigModule from "../../config.ts";
import * as PushRegistrations from "./PushRegistrations.ts";

const layer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(
    ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-push-store-test-" }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
);

it.effect("keeps registrations in a private file that survives a restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfigModule.ServerConfig;
    const receiver = NodeCrypto.createECDH("prime256v1");
    receiver.generateKeys();
    const registrations = yield* PushRegistrations.make({ allowInsecure: false });
    yield* registrations.upsert({
      sessionId: AuthSessionId.make("session-1"),
      registration: {
        deviceId: "device-1",
        label: "Pixel",
        environmentLabel: "Mac mini",
        endpoint: "https://ntfy.example.test/upTopic?up=1",
        p256dh: receiver.getPublicKey().toString("base64url"),
        auth: NodeCrypto.randomBytes(16).toString("base64url"),
        preferences: {
          notificationsEnabled: true,
          notifyOnApproval: true,
          notifyOnInput: true,
          notifyOnCompletion: true,
          notifyOnFailure: true,
        },
      },
    });

    const file = path.join(config.secretsDir, "fork-push-registrations.bin");
    assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((yield* fs.stat(config.secretsDir)).mode & 0o777, 0o700);

    const afterRestart = yield* PushRegistrations.make({ allowInsecure: false });
    assert.deepStrictEqual((yield* afterRestart.list).map(PushRegistrations.registrationTarget), [
      "https://ntfy.example.test/upTopic?up=1",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("starts empty instead of failing when the file is damaged", () =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set("fork-push-registrations", new TextEncoder().encode("{not json"));
    const registrations = yield* PushRegistrations.make({ allowInsecure: false });
    assert.equal((yield* registrations.list).length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("reads a file written before iPhones could register, and adds one beside it", () =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const now = "2026-11-01T00:00:00.000Z";
    const preferences = {
      notificationsEnabled: true,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    };
    // No `kind` on the old entry, exactly as builds before iOS support stored it.
    yield* secrets.set(
      "fork-push-registrations",
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          registrations: [
            {
              sessionId: "session-old",
              deviceId: "pixel",
              label: "Pixel",
              environmentLabel: "Mac mini",
              endpoint: "https://ntfy.example.test/upOld?up=1",
              p256dh: "BAAA",
              auth: "AAAA",
              preferences,
              createdAt: now,
              updatedAt: now,
              lastDelivery: null,
            },
          ],
        }),
      ),
    );
    const registrations = yield* PushRegistrations.make({
      allowInsecure: false,
      apnsConfigured: true,
    });
    assert.deepStrictEqual((yield* registrations.list).map(PushRegistrations.registrationTarget), [
      "https://ntfy.example.test/upOld?up=1",
    ]);

    yield* registrations.upsert({
      sessionId: AuthSessionId.make("session-ios"),
      registration: {
        kind: "apns",
        deviceId: "iphone",
        label: "iPhone",
        environmentLabel: "Mac mini",
        deviceToken: "AB".repeat(32),
        apsEnvironment: "development",
        bundleId: "com.example.app",
        preferences,
        templates: { completed: { title: "{thread}", body: "已完成" } },
      },
    });
    const afterRestart = yield* PushRegistrations.make({
      allowInsecure: false,
      apnsConfigured: true,
    });
    const stored = yield* afterRestart.list;
    assert.equal(stored.length, 2);
    const iphone = stored.find(PushRegistrations.isApnsRegistration);
    // Tokens are matched in one case, so a re-registration finds the old entry.
    assert.equal(iphone?.deviceToken, "ab".repeat(32));
    assert.equal(iphone?.templates?.completed?.body, "已完成");
  }).pipe(Effect.provide(layer)),
);
