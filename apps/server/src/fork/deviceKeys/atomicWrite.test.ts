// Replacing a file whole: no half file, no shared temporary name, nothing left behind after a failure.
// @effect-diagnostics nodeBuiltinImport:off -- Looks at the directory the way another process would.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { writeFileAtomic } from "./atomicWrite.ts";
import { writeDevicePublicUrl } from "./devicePublicUrlSync.ts";

const withTempDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-atomic-" });
    return yield* use(dir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("writeFileAtomic", () => {
  it.effect(
    "many concurrent writers leave one whole file with the right mode and no temporaries",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const file = NodePath.join(dir, "status.json");
          const contents = Array.from({ length: 40 }, (_, index) =>
            `{"n":${index}}`.padEnd(2000, " "),
          );
          yield* Effect.forEach(contents, (content) => writeFileAtomic(file, content, 0o600), {
            concurrency: "unbounded",
            discard: true,
          });
          assert.include(contents, NodeFS.readFileSync(file, "utf8"));
          assert.equal(NodeFS.statSync(file).mode & 0o777, 0o600);
          assert.deepEqual(NodeFS.readdirSync(dir), ["status.json"]);
        }),
      ),
  );

  it.effect("a failed write removes its own temporary file and keeps the old content", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const file = NodePath.join(dir, "taken");
        // A directory in the way makes the final rename fail after the temporary file exists.
        NodeFS.mkdirSync(NodePath.join(file, "inside"), { recursive: true });
        const failure = yield* Effect.flip(writeFileAtomic(file, "new", 0o600));
        assert.isDefined(failure);
        assert.deepEqual(NodeFS.readdirSync(dir), ["taken"]);

        const gone = NodePath.join(dir, "missing", "status.json");
        yield* Effect.flip(writeFileAtomic(gone, "new", 0o600));
        assert.deepEqual(NodeFS.readdirSync(dir), ["taken"]);
      }),
    ),
  );
});

describe("writeDevicePublicUrl", () => {
  it.effect("writes {url} only, replaces it whole, and removal leaves nothing", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const file = NodePath.join(dir, "device-public-url.json");
        yield* Effect.forEach(
          ["https://a.example", "https://b.example", "https://c.example"],
          (url) => writeDevicePublicUrl(dir, Option.some(url)),
          { concurrency: 1 },
        );
        assert.equal(NodeFS.readFileSync(file, "utf8"), '{"url":"https://c.example"}');
        assert.equal(NodeFS.statSync(file).mode & 0o777, 0o600);
        assert.deepEqual(NodeFS.readdirSync(dir), ["device-public-url.json"]);
        yield* writeDevicePublicUrl(dir, Option.none());
        yield* writeDevicePublicUrl(dir, Option.none());
        assert.deepEqual(NodeFS.readdirSync(dir), []);
      }),
    ),
  );
});
