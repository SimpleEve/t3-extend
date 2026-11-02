// fork: worktrees that belong to official T3 Code are never removed from here, by any caller.
import { GitCommandError, OFFICIAL_APP_NAME } from "@t3tools/contracts";
import { officialHomeDirectory } from "@t3tools/shared/forkIdentity";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

/**
 * Marks come from the import's own table. The file is opened read-only per check, so the lowest
 * removal function needs no SQL layer of its own and removals stay rare enough for that to be cheap.
 */
const readMarks = Effect.fn("SharedWorktrees.readMarks")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(dbPath))) return [];
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql.unsafe(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_t3code_import_map'`,
    );
    if (tables.length === 0) return [];
    const rows = yield* sql.unsafe<{ readonly source_id: string }>(
      `SELECT source_id FROM fork_t3code_import_map WHERE kind = 'worktree'`,
    );
    return rows.map((row) => row.source_id);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
});

/** Why this worktree must not be removed, or null when nothing ties it to official T3 Code. */
export const sharedWorktreeReason = Effect.fn("SharedWorktrees.reason")(function* (input: {
  readonly cwd: string;
  readonly path: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;

  // macOS and Windows compare names without regard to case, and a path that does not exist
  // yet cannot be corrected by realPath, so both sides are folded to the same key.
  const caseInsensitive = platform === "darwin" || platform === "win32";
  const key = (target: string) => {
    const resolved = path.resolve(target);
    return caseInsensitive ? resolved.normalize("NFC").toLowerCase() : resolved;
  };
  // Git follows symlinks through the nearest real ancestor, so the missing tail is kept as written.
  const realLocation = (target: string): Effect.Effect<string> =>
    fs.realPath(target).pipe(
      Effect.catch(() => {
        const parent = path.dirname(target);
        return parent === target
          ? Effect.succeed(target)
          : Effect.map(realLocation(parent), (real) => path.join(real, path.basename(target)));
      }),
    );
  const spellings = Effect.fn("SharedWorktrees.spellings")(function* (target: string) {
    const resolved = path.resolve(target);
    return [...new Set([key(resolved), key(yield* realLocation(resolved))])];
  });
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const target = yield* spellings(path.resolve(input.cwd, input.path));
  const official = yield* spellings(path.join(officialHomeDirectory(home, path.join), "worktrees"));
  const own = yield* spellings(config.worktreesDir);
  // A dev server run from inside an official worktree keeps its own worktrees under the official folder.
  const ownIsOfficial = own.some((root) => official.includes(root));
  const inOwn =
    !ownIsOfficial && target.some((spelling) => own.some((root) => inside(root, spelling)));
  if (!inOwn && target.some((spelling) => official.some((root) => inside(root, spelling)))) {
    return `This worktree lives in ${OFFICIAL_APP_NAME}'s worktrees folder. T3 Extend never removes it.`;
  }

  const marks = yield* readMarks(config.dbPath).pipe(
    Effect.map((sources) => ({ sources })),
    Effect.orElseSucceed(() => null),
  );
  // A mark that cannot be read could still be a shared worktree, so removal waits.
  if (marks === null) {
    return `Could not check whether this worktree is shared with ${OFFICIAL_APP_NAME}, so T3 Extend leaves it alone.`;
  }
  for (const source of marks.sources) {
    const marked = yield* spellings(source);
    if (marked.some((spelling) => target.includes(spelling))) {
      return `This worktree was created by ${OFFICIAL_APP_NAME} and is shared with it. T3 Extend never removes it.`;
    }
  }
  return null;
});

export const assertWorktreeRemovable = Effect.fn("SharedWorktrees.assertRemovable")(
  function* (input: { readonly operation: string; readonly cwd: string; readonly path: string }) {
    const reason = yield* sharedWorktreeReason(input);
    if (reason !== null) {
      return yield* new GitCommandError({
        operation: input.operation,
        command: "git worktree remove",
        cwd: input.cwd,
        detail: reason,
      });
    }
  },
);
