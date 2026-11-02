// fork: worktrees that belong to official T3 Code are never removed from here, by any caller.
import { GitCommandError, OFFICIAL_APP_NAME } from "@t3tools/contracts";
import { officialHomeDirectory } from "@t3tools/shared/forkIdentity";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

type Environment = FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig;

export interface SharedWorktreePolicy {
  /** True only for the policy that knows which worktrees an import shared. */
  readonly live: boolean;
  /** Why this worktree must not be removed, or null when nothing ties it to official T3 Code. */
  readonly refusal: (input: {
    readonly cwd: string;
    readonly path: string;
  }) => Effect.Effect<string | null, never, Environment>;
  /** Records worktrees an import left in official T3 Code's care, effective immediately. */
  readonly markShared: (paths: ReadonlyArray<string>) => Effect.Effect<void>;
}

/** Where a worktree sits, with every spelling of its location that Git could see it under. */
const locate = Effect.fn("SharedWorktrees.locate")(function* (input: {
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
  const where = (() => {
    if (!ownIsOfficial && target.some((spelling) => own.some((root) => inside(root, spelling)))) {
      return "own" as const;
    }
    return target.some((spelling) => official.some((root) => inside(root, spelling)))
      ? ("official" as const)
      : ("elsewhere" as const);
  })();
  return { where, target, spellings };
});

const OFFICIAL_FOLDER_REASON = `This worktree lives in ${OFFICIAL_APP_NAME}'s worktrees folder. T3 Extend never removes it.`;

/** Without markers: the path rule alone. */
const pathRulePolicy: SharedWorktreePolicy = {
  live: false,
  refusal: Effect.fn("SharedWorktrees.pathRule")(function* (input) {
    const { where } = yield* locate(input);
    return where === "official" ? OFFICIAL_FOLDER_REASON : null;
  }),
  markShared: () => Effect.void,
};

/**
 * The policy `removeLinkedWorktree` and storage clean-up consult. Its default is the path rule, so
 * the many callers of the Git driver need no wiring; the server provides `layer` once at its base.
 */
export const SharedWorktreePolicy = Context.Reference<SharedWorktreePolicy>(
  "t3x/fork/SharedWorktrees/SharedWorktreePolicy",
  { defaultValue: () => pathRulePolicy },
);

/** Fails start-up when the server was composed without `layer`, since imports could not protect their worktrees. */
export const requireLivePolicy = Effect.fn("SharedWorktrees.requireLive")(function* () {
  const policy = yield* SharedWorktreePolicy;
  if (!policy.live) {
    return yield* Effect.die(
      new Error(
        "SharedWorktrees.layer is missing from the server's layers; worktree marks would not take effect.",
      ),
    );
  }
  return policy;
});

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

/**
 * Loads the import's markers and keeps them in memory, so a removal does no database I/O.
 * While they are unknown, everything outside T3 Extend's own worktrees folder is refused; the next
 * `markShared` (the start of an import) tries the load again.
 */
export const layer = Layer.effect(
  SharedWorktreePolicy,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const load = ensureImportTables().pipe(
      Effect.andThen(
        sql.unsafe<{ readonly source_id: string }>(
          `SELECT source_id FROM fork_t3code_import_map WHERE kind = 'worktree'`,
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.source_id)),
      Effect.tapError((error) =>
        Effect.logError(
          "SharedWorktrees: could not load shared worktree markers; refusing removals outside T3 Extend's own worktrees folder",
          error,
        ),
      ),
      Effect.orElseSucceed(() => null),
      // Reloaded later from `markShared`, whose caller owns no SqlClient of its own to lend.
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const initial = yield* load;
    // `loaded: false` means the database's markers are unknown; `marked` still holds what this process was told.
    const state = yield* Ref.make({ loaded: initial !== null, marked: new Set(initial ?? []) });

    return SharedWorktreePolicy.of({
      live: true,
      refusal: Effect.fn("SharedWorktrees.refusal")(function* (input) {
        const { where, target, spellings } = yield* locate(input);
        if (where === "official") return OFFICIAL_FOLDER_REASON;
        const { loaded, marked: sources } = yield* Ref.get(state);
        for (const source of sources) {
          const marked = yield* spellings(source);
          if (marked.some((spelling) => target.includes(spelling))) {
            return `This worktree was created by ${OFFICIAL_APP_NAME} and is shared with it. T3 Extend never removes it.`;
          }
        }
        if (loaded || where === "own") return null;
        // Imported worktrees never live in this environment's own folder, so its clean-up keeps working.
        return `Could not check whether this worktree is shared with ${OFFICIAL_APP_NAME}, so T3 Extend leaves it alone.`;
      }),
      markShared: Effect.fn("SharedWorktrees.markShared")(function* (paths) {
        const reloaded = (yield* Ref.get(state)).loaded ? null : yield* load;
        yield* Ref.update(state, (current) => ({
          loaded: current.loaded || reloaded !== null,
          marked: new Set([...current.marked, ...(reloaded ?? []), ...paths]),
        }));
      }),
    });
  }),
);

export const assertWorktreeRemovable = Effect.fn("SharedWorktrees.assertRemovable")(
  function* (input: { readonly operation: string; readonly cwd: string; readonly path: string }) {
    const policy = yield* SharedWorktreePolicy;
    const reason = yield* policy.refusal(input);
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
