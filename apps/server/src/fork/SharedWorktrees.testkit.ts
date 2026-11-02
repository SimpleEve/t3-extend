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
import * as SharedWorktrees from "./SharedWorktrees.ts";
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

/** The live policy over an in-memory database, as the server provides it. */
export const liveSharedWorktreePolicyLayer = SharedWorktrees.layer.pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

/**
 * A live policy built over a database that already holds the given markers, or whose marker table
 * cannot be read when `unreadable` is set.
 */
const makeLivePolicy = Effect.fn("SharedWorktrees.testkit.makePolicy")(function* (options: {
  readonly marked?: ReadonlyArray<string>;
  readonly unreadable?: boolean;
}) {
  const sqlContext = yield* NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
    Layer.build,
    Effect.orDie,
  );
  const sql = Context.get(sqlContext, SqlClient.SqlClient);
  if (options.unreadable === true) {
    yield* sql`CREATE TABLE fork_t3code_import_map (kind TEXT)`.pipe(Effect.orDie);
  } else {
    yield* SharedWorktrees.ensureImportTables().pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.orDie,
    );
    for (const target of options.marked ?? []) {
      yield* sql`INSERT INTO fork_t3code_import_map
        (kind, source_id, target_id, state, imported_at)
        VALUES ('worktree', ${target}, ${target}, 'shared', 'now')`.pipe(Effect.orDie);
    }
  }
  const context = yield* SharedWorktrees.layer.pipe(
    Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
    Layer.build,
  );
  return Context.get(context, SharedWorktrees.SharedWorktreePolicy);
});

/**
 * `removeWorktree` as GitWorkflowService would call it, backed by the real driver. `spawned` lists
 * the worktree removals that got past the guard and reached Git.
 */
export const makeGuardedRemoveWorktree = Effect.fn("SharedWorktrees.testkit.make")(
  function* (options: {
    readonly home: string;
    readonly marked?: ReadonlyArray<string>;
    readonly unreadable?: boolean;
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
    const policy = yield* makeLivePolicy({
      ...(options.marked === undefined ? {} : { marked: options.marked }),
      ...(options.unreadable === undefined ? {} : { unreadable: options.unreadable }),
    });
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
      Layer.provide(Layer.succeed(SharedWorktrees.SharedWorktreePolicy, policy)),
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
    return { removeWorktree, attempts, spawned, config, policy };
  },
);
