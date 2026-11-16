import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { removeLinkedWorktreeInSection } from "../vcs/worktreeRemoval.ts";

import * as SqlClient from "effect/sql/SqlClient";

import {
  addColumnIfMissing,
  ensureImportTables,
  requireLivePolicy,
  SharedWorktreePolicy,
  type SharedWorktreePolicy as SharedWorktreePolicyShape,
  type SharedWorktreeSection,
} from "./SharedWorktrees.ts";
import { makeGuardedRemoveWorktree } from "./SharedWorktrees.testkit.ts";

const path_ = (...segments: Array<string>) => segments.join("/");

const setup = Effect.fn("setup")(function* (options?: {
  readonly marked?: ReadonlyArray<string>;
  readonly unreadable?: boolean;
  readonly baseDir?: (home: string) => string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-wt-" }));
  const home = path.join(root, "home");
  const official = path.join(home, ".t3", "worktrees");
  yield* fs.makeDirectory(path.join(official, "repo", "feature"), { recursive: true });
  yield* fs.makeDirectory(path.join(root, "mine", "feature"), { recursive: true });
  yield* fs.makeDirectory(path.join(root, "elsewhere", "Marked"), { recursive: true });
  yield* fs.symlink(official, path.join(root, "link"));
  const guarded = yield* makeGuardedRemoveWorktree({
    home,
    marked: (options?.marked ?? []).map((target) => path.join(root, target)),
    ...(options?.unreadable === undefined ? {} : { unreadable: options.unreadable }),
    ...(options?.baseDir === undefined ? {} : { baseDir: options.baseDir(home) }),
  });
  const refused = (target: string, platform: NodeJS.Platform = "linux") =>
    guarded
      .removeWorktree({ cwd: path.join(root, "repo"), path: target, force: true })
      .pipe(Effect.provideService(HostProcess.Platform, platform), Effect.exit);
  return { fs, path, root, home, official, guarded, refused };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("SharedWorktrees", (it) => {
  it.effect("refuses anything under official T3 Code's folder, however the path is spelled", () =>
    Effect.gen(function* () {
      const { path, root, official, guarded, refused } = yield* setup();
      const targets = [
        path.join(official, "repo", "feature"),
        `${path.join(official, "repo", "feature")}/`,
        path.join(official, "repo", "does-not-exist-yet"),
        official,
        // A symlink into the folder, whether or not the end of the path exists.
        path.join(root, "link", "repo", "feature"),
        path.join(root, "link", "repo", "not-there", "deeper"),
      ];
      for (const target of targets) {
        assert.isTrue(Exit.isFailure(yield* refused(target)), `${target} should be refused`);
      }
      assert.deepStrictEqual(guarded.spawned, []);
    }),
  );

  it.effect(
    "compares without regard to case on macOS and Windows, even for paths that do not exist",
    () =>
      Effect.gen(function* () {
        const { path, official, home, guarded, refused } = yield* setup();
        const variant = path.join(home, ".T3", "WORKTREES", "Repo", "never-created");
        for (const platform of ["darwin", "win32"] as const) {
          assert.isTrue(Exit.isFailure(yield* refused(variant, platform)));
          assert.isTrue(Exit.isFailure(yield* refused(path.join(official, "REPO"), platform)));
        }
        assert.deepStrictEqual(guarded.spawned, []);
      }),
  );

  it.effect("refuses what an import marked as shared, in any spelling", () =>
    Effect.gen(function* () {
      const { path, root, guarded, refused } = yield* setup({
        marked: [path_("elsewhere", "Marked")],
      });
      const marked = path.join(root, "elsewhere", "Marked");
      assert.isTrue(Exit.isFailure(yield* refused(marked)));
      assert.isTrue(Exit.isFailure(yield* refused(`${marked}/`)));
      assert.isTrue(
        Exit.isFailure(yield* refused(path.join(root, "elsewhere", "MARKED"), "darwin")),
      );
      assert.deepStrictEqual(guarded.spawned, []);
    }),
  );

  it.effect(
    "lets other worktrees through to Git, including a sibling folder with a similar name",
    () =>
      Effect.gen(function* () {
        const { path, root, home, guarded, refused } = yield* setup();
        const allowed = [
          path.join(root, "mine", "feature"),
          path.join(home, ".t3", "worktrees-extra", "x"),
        ];
        for (const target of allowed) assert.isTrue(Exit.isSuccess(yield* refused(target)));
        assert.strictEqual(guarded.spawned.length, 2);
      }),
  );

  it.effect(
    "keeps this environment's own worktrees removable when it lives under the official folder",
    () =>
      Effect.gen(function* () {
        const { official, guarded, refused } = yield* setup({
          baseDir: (home) => path_(home, ".t3", "worktrees", "own"),
        });
        assert.isTrue(
          Exit.isSuccess(yield* refused(path_(official, "own", "worktrees", "r", "b"))),
        );
        assert.isTrue(Exit.isFailure(yield* refused(path_(official, "repo", "feature"))));
        assert.strictEqual(guarded.spawned.length, 1);
      }),
  );

  it.effect(
    "when the markers cannot be loaded, refuses outside this environment's own folder and keeps clean-up working inside it",
    () =>
      Effect.gen(function* () {
        const { path, root, guarded, refused } = yield* setup({ unreadable: true });
        assert.isTrue(Exit.isFailure(yield* refused(path.join(root, "mine", "feature"))));
        assert.deepStrictEqual(guarded.spawned, []);
        assert.isTrue(
          Exit.isSuccess(yield* refused(path.join(guarded.config.worktreesDir, "repo", "branch"))),
        );
        assert.strictEqual(guarded.spawned.length, 1);
      }),
  );

  it.effect(
    "recovers the known markers at the next import once the database is readable again",
    () =>
      Effect.gen(function* () {
        const { path, root, guarded, refused } = yield* setup({ unreadable: true });
        const outside = path.join(root, "mine", "feature");
        const fromImport = path.join(root, "mine", "imported");
        const fromDatabase = path.join(root, "elsewhere", "Marked");

        // Still unreadable: the import's own marks hold, everything else outside stays refused.
        yield* guarded.policy.markShared([fromImport]);
        assert.isTrue(Exit.isFailure(yield* refused(outside)));
        assert.isTrue(Exit.isFailure(yield* refused(fromImport)));

        yield* guarded.sql`DROP TABLE fork_t3code_import_map`;
        yield* ensureImportTables().pipe(Effect.provideService(SqlClient.SqlClient, guarded.sql));
        yield* guarded.sql`INSERT INTO fork_t3code_import_map
          (kind, source_id, target_id, state, imported_at)
          VALUES ('worktree', ${fromDatabase}, ${fromDatabase}, 'shared', 'now')`;
        // Nothing reloads by itself; the next import does.
        assert.isTrue(Exit.isFailure(yield* refused(outside)));

        yield* guarded.policy.markShared([fromImport]);
        assert.isTrue(Exit.isSuccess(yield* refused(outside)));
        assert.isTrue(Exit.isFailure(yield* refused(fromDatabase)));
        assert.isTrue(Exit.isFailure(yield* refused(fromImport)));
        assert.strictEqual(guarded.spawned.length, 1);
      }),
  );

  it.effect("adding a bookkeeping column that another start already added is not an error", () =>
    Effect.gen(function* () {
      const { guarded } = yield* setup();
      const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        effect.pipe(Effect.provideService(SqlClient.SqlClient, guarded.sql));
      yield* run(ensureImportTables());
      // Two starts that both found the column missing both reach the ALTER; the second loses.
      yield* run(addColumnIfMissing("fork_t3code_import_map", "source_version"));
      yield* run(ensureImportTables());
      const columns = yield* guarded.sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('fork_t3code_import_map')`;
      assert.deepStrictEqual(
        columns.map((column) => column.name).filter((name) => name.startsWith("source_")),
        ["source_id", "source_version", "source_runs", "source_meta"],
      );
      // Only the duplicate is swallowed.
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(run(addColumnIfMissing("no_such_table", "source_version"))),
        ),
      );
    }),
  );

  it.effect("on a database no import ever touched, refuses nothing T3 Extend owns", () =>
    Effect.gen(function* () {
      const { path, root, guarded, refused } = yield* setup();
      assert.isTrue(
        Exit.isSuccess(yield* refused(path.join(guarded.config.worktreesDir, "repo", "branch"))),
      );
      assert.isTrue(Exit.isSuccess(yield* refused(path.join(root, "mine", "feature"))));
      assert.strictEqual(guarded.spawned.length, 2);
    }),
  );

  it.effect("takes effect for markers written by an import without a restart", () =>
    Effect.gen(function* () {
      const { path, root, guarded, refused } = yield* setup();
      const target = path.join(root, "mine", "feature");
      assert.isTrue(Exit.isSuccess(yield* refused(target)));
      yield* guarded.policy.markShared([target]);
      assert.isTrue(Exit.isFailure(yield* refused(target)));
      assert.strictEqual(guarded.spawned.length, 1);
    }),
  );

  {
    const section = Effect.fn("section")(function* () {
      const { path, root, guarded } = yield* setup();
      const policy = guarded.policy;
      const input = (name: string) => ({
        cwd: root,
        path: path.join(root, "mine", name),
      });
      const provide = <A, E>(
        effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig>,
      ) => effect.pipe(Effect.provideService(ServerConfig.ServerConfig, guarded.config));
      return { policy, input, provide, config: guarded.config };
    });
    const refusedNow = (
      policy: SharedWorktreePolicyShape,
      target: { readonly cwd: string; readonly path: string },
      config: ServerConfig.ServerConfig["Service"],
    ) =>
      policy.refusal(target).pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.map((reason) => reason !== null),
      );

    it.effect("a mark that starts during a section applies only after the section ends", () =>
      Effect.gen(function* () {
        const { policy, input, provide, config } = yield* section();
        const target = input("feature");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const inSection = yield* Effect.forkChild(
          provide(
            policy.exclusive(target, () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
          ),
        );
        yield* Deferred.await(entered);
        const marking = yield* Effect.forkChild(policy.markShared([target.path]), {
          startImmediately: true,
        });
        assert.isUndefined(marking.pollUnsafe());
        assert.isFalse(yield* refusedNow(policy, target, config));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(inSection);
        yield* Fiber.join(marking);
        assert.isTrue(yield* refusedNow(policy, target, config));
      }),
    );

    it.effect("a section that gets the permit after a mark sees it and does not run", () =>
      Effect.gen(function* () {
        const { policy, input, provide } = yield* section();
        const target = input("feature");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const ran: Array<string> = [];
        const holder = yield* Effect.forkChild(
          provide(
            policy.exclusive(input("other"), () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
          ),
        );
        yield* Deferred.await(entered);
        // The mark queues for the permit first, then the section that would clean the same path.
        const marking = yield* Effect.forkChild(policy.markShared([target.path]), {
          startImmediately: true,
        });
        const waiting = yield* Effect.forkChild(
          provide(
            policy.exclusive(target, () => Effect.sync(() => void ran.push("destroyed"))),
          ).pipe(Effect.exit),
          { startImmediately: true },
        );
        assert.isUndefined(waiting.pollUnsafe());
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(marking);
        const exit = yield* Fiber.join(waiting);
        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(ran, []);
      }),
    );

    it.effect("a mark cannot slip in while the section's own re-check is still running", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { policy, input, provide } = yield* section();
        const target = input("feature");
        const paused = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const log: Array<string> = [];
        // The re-check reads the file system; hold it there, as a slow disk would.
        const slowFs = FileSystem.FileSystem.of({
          ...fs,
          realPath: (candidate) =>
            candidate === target.path
              ? Deferred.succeed(paused, undefined).pipe(
                  Effect.andThen(Deferred.await(resume)),
                  Effect.andThen(fs.realPath(candidate)),
                )
              : fs.realPath(candidate),
        });
        const section_ = yield* Effect.forkChild(
          provide(
            policy.exclusive(target, () => Effect.sync(() => void log.push("destroyed"))),
          ).pipe(Effect.provideService(FileSystem.FileSystem, slowFs)),
          { startImmediately: true },
        );
        yield* Deferred.await(paused);
        const marking = yield* Effect.forkChild(
          policy
            .markShared([target.path])
            .pipe(Effect.andThen(Effect.sync(() => void log.push("marked")))),
          { startImmediately: true },
        );
        // Taking the permit first is what keeps the mark out; a check outside it would let it finish here.
        assert.isUndefined(marking.pollUnsafe());
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(section_);
        yield* Fiber.join(marking);
        assert.deepStrictEqual(log, ["destroyed", "marked"]);
      }),
    );
    const removal = (
      target: { readonly cwd: string; readonly path: string },
      removed: Array<string>,
    ) => ({
      operation: "test",
      cwd: target.cwd,
      worktreePath: target.path,
      force: false,
      execute: () => Effect.die("unused"),
      run: () => Effect.sync(() => void removed.push(target.path)),
    });

    it.effect("a token kept past its section cannot remove", () =>
      Effect.gen(function* () {
        const { policy, input, provide } = yield* section();
        const target = input("feature");
        const removed: Array<string> = [];
        const go = yield* Deferred.make<void>();
        const refusedLate = yield* Deferred.make<boolean>();
        yield* provide(
          policy.exclusive(target, (token) =>
            Effect.gen(function* () {
              // Inside the section the same token works.
              yield* removeLinkedWorktreeInSection(token, removal(target, removed));
              yield* Effect.forkChild(
                Deferred.await(go).pipe(
                  Effect.andThen(removeLinkedWorktreeInSection(token, removal(target, removed))),
                  Effect.exit,
                  Effect.flatMap((exit) => Deferred.succeed(refusedLate, Exit.isFailure(exit))),
                ),
              );
            }),
          ),
        );
        yield* policy.markShared([target.path]);
        yield* Deferred.succeed(go, undefined);
        assert.isTrue(yield* Deferred.await(refusedLate));
        assert.deepStrictEqual(removed, [target.path]);
      }),
    );

    it.effect("a token that did not come from a section is refused", () =>
      Effect.gen(function* () {
        const { input } = yield* section();
        const target = input("feature");
        const removed: Array<string> = [];
        const exit = yield* Effect.exit(
          removeLinkedWorktreeInSection({} as SharedWorktreeSection, removal(target, removed)),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(removed, []);
      }),
    );
  }

  it.effect("start-up fails unless the live policy is provided", () =>
    Effect.gen(function* () {
      const { guarded } = yield* setup();
      assert.isTrue(Exit.isFailure(yield* Effect.exit(requireLivePolicy())));
      const live = yield* requireLivePolicy().pipe(
        Effect.provideService(SharedWorktreePolicy, guarded.policy),
      );
      assert.isTrue(live.live);
    }),
  );
});
