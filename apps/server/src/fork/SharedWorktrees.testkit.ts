// fork: the real Git driver, and so the real removal guard, over a spawner that only records what Git is asked to do.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const exitedHandle = ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(1),
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  unref: Effect.succeed(Effect.void),
  stdin: Sink.drain,
  stdout: Stream.empty,
  stderr: Stream.empty,
  all: Stream.empty,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
});

/** Writes the rows an import leaves behind for worktrees it shares with official T3 Code. */
export const markSharedWorktrees = Effect.fn("SharedWorktrees.testkit.mark")(function* (
  dbPath: string,
  paths: ReadonlyArray<string>,
) {
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS fork_t3code_import_map (
      kind TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      state TEXT NOT NULL, detail TEXT, imported_at TEXT NOT NULL, PRIMARY KEY (kind, source_id))`;
    for (const path of paths) {
      yield* sql`INSERT OR IGNORE INTO fork_t3code_import_map
        (kind, source_id, target_id, state, imported_at)
        VALUES ('worktree', ${path}, ${path}, 'shared', 'now')`;
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })), Effect.orDie);
});

/**
 * `removeWorktree` as GitWorkflowService would call it, backed by the real driver. `spawned` lists
 * the worktree removals that got past the guard and reached Git.
 */
export const makeGuardedRemoveWorktree = Effect.fn("SharedWorktrees.testkit.make")(
  function* (options: {
    readonly home: string;
    readonly marked?: ReadonlyArray<string>;
    /** Where this environment keeps its own state; its worktrees folder is `<baseDir>/worktrees`. */
    readonly baseDir?: string;
  }) {
    const attempts: Array<string> = [];
    const spawned: Array<string> = [];
    const config = yield* ServerConfig.ServerConfig.layerTest(
      process.cwd(),
      options.baseDir ?? { prefix: "t3-guarded-remove-" },
    ).pipe(
      Layer.build,
      Effect.provide(NodeServices.layer),
      Effect.map((context) => Context.get(context, ServerConfig.ServerConfig)),
    );
    yield* markSharedWorktrees(config.dbPath, options.marked ?? []);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const { command: executable, args } = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        if (args.includes("worktree") && args.includes("remove"))
          spawned.push([executable, ...args].join(" "));
        return exitedHandle;
      }),
    );
    const context = yield* GitVcsDriver.layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
      Layer.provide(NodeServices.layer),
      Layer.build,
    );
    const driver = Context.get(context, GitVcsDriver.GitVcsDriver);
    const removeWorktree = (
      input: Parameters<GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"]>[0],
    ) => {
      attempts.push(input.path);
      return driver
        .removeWorktree(input)
        .pipe(Effect.provideService(HostProcess.HomeDirectory, options.home));
    };
    return { removeWorktree, attempts, spawned, config };
  },
);
