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

  // Shared external state: each of these hands the fork something official T3 Code also owns.
  it.effect.each([
    "export const DEFAULT_TAILSCALE_SERVE_PORT = 443;",
    "const settings = { tailscaleServePort: 443 };",
    "const port = pick(flag, () => 443, other);",
    'const ref = "refs/t3code/pre-refresh";',
    "const ref = `refs/t3/review-guide/${runId}/base`;",
    "const branch = `t3code/pr-${number}/${name}`;",
    'export const WORKTREE_BRANCH_PREFIX = "t3";',
    '  branchNamePrefix: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("t3"))),',
    "const own = new RegExp(`^(?:t3code(?:[-/]${hex}))$`);",
    "const strip = new RegExp(`^(?:${PREFIX}|t3|t3code)/`);",
  ])("rejects the shared-state literal %s", (source) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-guard-shared-" });
      installGuard(root);
      yield* fs.makeDirectory(path.join(root, "apps", "server", "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "apps", "server", "src", "shared.ts"),
        `${source}\n`,
      );

      const result = runGuard(root);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "apps/server/src/shared.ts:1");
    }),
  );

  it.effect(
    "allows the display-only compatibility references it lists, and nothing else there",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-guard-compat-" });
        installGuard(root);
        const shared = path.join(root, "packages", "shared", "src");
        yield* fs.makeDirectory(shared, { recursive: true });
        yield* fs.writeFileString(
          path.join(shared, "git.ts"),
          'const OFFICIAL_WORKTREE_BRANCH_PREFIX = "t3";\nexport const WORKTREE_BRANCH_PREFIX = "t3";\n',
        );

        const result = runGuard(root);
        assert.notEqual(result.status, 0);
        assert.notInclude(result.stderr, "packages/shared/src/git.ts:1:");
        assert.include(result.stderr, "packages/shared/src/git.ts:2:");
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

  it.effect("rejects T3 Code split across lines in JSX text and template literals", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-guard-multiline-" });
      installGuard(root);
      const source = path.join(root, "apps", "web", "src");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "heading.tsx"),
        "export const Heading = () => (\n  <h1>\n    Welcome to T3\n    Code\n  </h1>\n);\n",
      );
      yield* fs.writeFileString(
        path.join(source, "message.ts"),
        "export const message = `Open the\nT3\n  Code window`;\nexport const second = `first line\nT3 Code`;\n",
      );

      const result = runGuard(root);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "apps/web/src/heading.tsx:3");
      assert.include(result.stderr, "apps/web/src/message.ts:2");
      assert.include(result.stderr, "apps/web/src/message.ts:5");
      assert.include(result.stderr, '3 user-visible "T3 Code" literal(s)');
    }),
  );

  it.effect("rejects a static copy of the app name that drifted from forkIdentity.ts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-guard-drift-" });
      installGuard(root);
      yield* fs.makeDirectory(path.join(root, "packages", "shared", "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "packages", "shared", "src", "forkIdentity.ts"),
        'export const FORK = { appBaseName: "Renamed App" } as const;\n',
      );
      yield* fs.makeDirectory(path.join(root, "apps", "web", "public"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "apps", "web", "public", "manifest.webmanifest"),
        '{\n  "name": "Renamed App",\n  "short_name": "T3 Extend"\n}\n',
      );

      const result = runGuard(root);
      assert.notEqual(result.status, 0);
      assert.include(
        result.stderr,
        'apps/web/public/manifest.webmanifest: "T3 Extend" does not match FORK.appBaseName "Renamed App"',
      );
      assert.notInclude(result.stderr, 'manifest.webmanifest: "Renamed App"');
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
