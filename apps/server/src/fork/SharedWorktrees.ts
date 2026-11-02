// fork: worktrees that belong to official T3 Code are never removed from here, by any caller.
import * as NodeOS from "node:os";

import { GitCommandError } from "@t3tools/contracts";
import { officialHomeDirectory } from "@t3tools/shared/forkIdentity";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

/** Import bookkeeping lives in fork-owned tables, never in a numbered migration (see FORK.md). */
export const ensureImportTables = Effect.fn("SharedWorktrees.ensureImportTables")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_t3code_import_map (
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (kind, source_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_t3code_import_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    source_path TEXT NOT NULL,
    summary_json TEXT
  )`;
});

export class SharedWorktrees extends Context.Service<
  SharedWorktrees,
  {
    /** Fails for a worktree an import marked as shared and for anything under official T3 Code's worktrees folder. */
    readonly assertRemovable: (input: {
      readonly cwd: string;
      readonly path: string;
    }) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/fork/SharedWorktrees") {}

const make = Effect.fn("SharedWorktrees.make")(function* (
  officialWorktreesDir: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* ensureImportTables();

  const official =
    officialWorktreesDir ??
    path.join(officialHomeDirectory(NodeOS.homedir(), path.join), "worktrees");
  const canonical = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const refuse = (cwd: string, detail: string) =>
    new GitCommandError({
      operation: "SharedWorktrees.assertRemovable",
      command: "git worktree remove",
      cwd,
      detail,
    });

  const assertRemovable = Effect.fn("SharedWorktrees.assertRemovable")(function* (input: {
    readonly cwd: string;
    readonly path: string;
  }) {
    const target = path.resolve(input.cwd, input.path);
    const spellings = [target, yield* canonical(target)];
    const roots = [path.resolve(official), yield* canonical(official)];
    if (spellings.some((spelling) => roots.some((root) => inside(root, spelling)))) {
      return yield* refuse(
        input.cwd,
        "This worktree lives in T3 Code's worktrees folder. T3 Extend never removes it.",
      );
    }
    const marked = yield* sql
      .unsafe<{ readonly source_id: string }>(
        `SELECT source_id FROM fork_t3code_import_map WHERE kind = 'worktree'`,
      )
      .pipe(
        Effect.mapError((cause) =>
          refuse(input.cwd, `Could not check shared worktrees: ${String(cause)}`),
        ),
      );
    if (marked.some((row) => spellings.includes(row.source_id))) {
      return yield* refuse(
        input.cwd,
        "This worktree was created by T3 Code and is shared with it. T3 Extend never removes it.",
      );
    }
  });

  return SharedWorktrees.of({ assertRemovable });
});

export const layer = Layer.effect(SharedWorktrees, make(undefined));

/** Tests point the official worktrees folder at a fixture. */
export const layerWithOfficialWorktrees = (officialWorktreesDir: string) =>
  Layer.effect(SharedWorktrees, make(officialWorktreesDir));

/** For layers that have no import bookkeeping to consult. */
export const layerNone = Layer.succeed(SharedWorktrees, {
  assertRemovable: Effect.fn("SharedWorktrees.assertRemovableNone")(() => Effect.void),
});
