// @effect-diagnostics nodeBuiltinImport:off - Exercises the guard as the standalone script it ships as.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const guardSourcePath = NodePath.join(import.meta.dirname, "fork-identity-guard.ts");

const installGuard = (root: string) => {
  const scriptDirectory = NodePath.join(root, "scripts");
  NodeFS.mkdirSync(scriptDirectory, { recursive: true });
  NodeFS.copyFileSync(guardSourcePath, NodePath.join(scriptDirectory, "fork-identity-guard.ts"));
};

const runGuard = (root: string) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(root, "scripts", "fork-identity-guard.ts")],
    { cwd: root, encoding: "utf8" },
  );

it.layer(NodeServices.layer)("fork-identity-guard", (it) => {
  it.effect("rejects an official identity literal outside the allowlist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-guard-violation-" });
      installGuard(root);
      yield* fs.makeDirectory(path.join(root, "apps", "server", "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "apps", "server", "src", "identity.ts"),
        'export const appId = "com.t3tools.t3code";\n',
      );

      const result = runGuard(root);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "apps/server/src/identity.ts:1");
      assert.include(result.stderr, "1 official identity literal(s)");
    }),
  );

  it.effect("rejects a user-visible T3 Code literal outside the brand allowlist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-guard-brand-" });
      installGuard(root);
      yield* fs.makeDirectory(path.join(root, "apps", "web", "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "apps", "web", "src", "title.ts"),
        'export const title = "T3 Code could not start";\n// T3 Code in a comment is fine.\n',
      );

      const result = runGuard(root);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "apps/web/src/title.ts:1");
      assert.notInclude(result.stderr, "apps/web/src/title.ts:2");
      assert.include(result.stderr, '1 user-visible "T3 Code" literal(s)');
    }),
  );

  it.effect("rejects a stale allowlist entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-guard-stale-" });
      installGuard(root);

      const result = runGuard(root);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "stale allowlist entry:");
      assert.include(result.stderr, "stale allowlist entr(ies)");
      assert.include(result.stderr, "stale brand allowlist entry:");
    }),
  );
});
