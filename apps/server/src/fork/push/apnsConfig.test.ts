// @effect-diagnostics nodeBuiltinImport:off -- The test writes a real .p8 key file.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  APNS_KEY_FILE_ENV,
  APNS_KEY_ID_ENV,
  APNS_TEAM_ID_ENV,
  loadApnsConfig,
} from "./apnsConfig.ts";

const withKeyFile = (contents: (pem: string) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-apns-config-test-" });
    const file = path.join(directory, "AuthKey.p8");
    const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    yield* fs.writeFileString(
      file,
      contents(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    );
    return file;
  });

const env = (file: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  [APNS_KEY_FILE_ENV]: file,
  [APNS_KEY_ID_ENV]: "ABC123DEFG",
  [APNS_TEAM_ID_ENV]: "TEAM123456",
  ...overrides,
});

it.effect("is off when nothing is set, without complaint", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* loadApnsConfig({}), { status: "absent" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("loads a .p8 key", () =>
  Effect.gen(function* () {
    const file = yield* withKeyFile((pem) => pem);
    const config = yield* loadApnsConfig(env(file));
    assert.equal(config.status, "configured");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports what is wrong instead of failing, and never repeats the key", () =>
  Effect.gen(function* () {
    const garbage = yield* withKeyFile(() => "-----BEGIN PRIVATE KEY-----\nnot a key\n");
    const notAKey = yield* loadApnsConfig(env(garbage));
    assert.equal(notAKey.status, "invalid");
    assert.notInclude(JSON.stringify(notAKey), "not a key");

    const rsa = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongType = yield* withKeyFile(() =>
      rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    assert.equal((yield* loadApnsConfig(env(wrongType))).status, "invalid");

    const missing = yield* loadApnsConfig(env("/nonexistent/AuthKey.p8"));
    assert.equal(missing.status, "invalid");

    const partial = yield* loadApnsConfig({ [APNS_KEY_ID_ENV]: "ABC123DEFG" });
    assert.equal(partial.status, "invalid");

    const good = yield* withKeyFile((pem) => pem);
    assert.equal(
      (yield* loadApnsConfig(env(good, { [APNS_TEAM_ID_ENV]: "short" }))).status,
      "invalid",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
