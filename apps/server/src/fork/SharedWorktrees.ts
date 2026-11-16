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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

type Environment = FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig;

/** A destructive section did not run because the worktree is shared with official T3 Code. */
export class SharedWorktreeRefused extends Schema.TaggedError<SharedWorktreeRefused>()(
  "SharedWorktreeRefused",
  { reason: Schema.String },
) {}

const isSharedWorktreeRefused = Schema.is(SharedWorktreeRefused);

declare const sectionBrand: unique symbol;

/** Proof that the caller is inside `exclusive`; destructive helpers ask for it as an argument. */
export interface SharedWorktreeSection {
  readonly [sectionBrand]: true;
}

/** One per `exclusive` call, never exported: only an instance still `live` passes `assertSectionLive`. */
class Section {
  declare readonly [sectionBrand]: true;
  live = true;
}

export interface SharedWorktreePolicy {
  /** True only for the policy that knows which worktrees an import shared. */
  readonly live: boolean;
  /** Why this worktree must not be removed, or null when nothing ties it to official T3 Code. */
  readonly refusal: (input: {
    readonly cwd: string;
    readonly path: string;
  }) => Effect.Effect<string | null, never, Environment>;
  /**
   * Runs a destructive effect only if the worktree is still unshared, holding the permit `markShared`
   * also takes. Not reentrant: the effect gets proof of the section instead of calling this again.
   */
  readonly exclusive: <A, E, R>(
    input: { readonly cwd: string; readonly path: string },
    effect: (section: SharedWorktreeSection) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SharedWorktreeRefused, R | Environment>;
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

/** Checks `refusal` again, then runs the effect; shared by both policies. */
const checkedThenRun = Effect.fn("SharedWorktrees.checkedThenRun")(function* <A, E, R>(
  refusal: SharedWorktreePolicy["refusal"],
  input: { readonly cwd: string; readonly path: string },
  effect: (section: SharedWorktreeSection) => Effect.Effect<A, E, R>,
) {
  const reason = yield* refusal(input);
  if (reason !== null) return yield* new SharedWorktreeRefused({ reason });
  const section = new Section();
  // Dead on every exit, so a token kept past the section cannot act without the permit.
  return yield* effect(section).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        section.live = false;
      }),
    ),
  );
});

/** Without markers: the path rule alone, which nothing can change, so it needs no lock. */
const pathRulePolicy: SharedWorktreePolicy = {
  live: false,
  refusal: Effect.fn("SharedWorktrees.pathRule")(function* (input) {
    const { where } = yield* locate(input);
    return where === "official" ? OFFICIAL_FOLDER_REASON : null;
  }),
  exclusive: (input, effect) => checkedThenRun(pathRulePolicy.refusal, input, effect),
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

const errorText = (error: unknown): string =>
  error instanceof Error
    ? `${error.message} ${errorText((error as { cause?: unknown }).cause)}`
    : typeof error === "object" && error !== null && "cause" in error
      ? errorText((error as { cause?: unknown }).cause)
      : String(error);

/**
 * Adds a column in place (the fork has no numbered migrations). Adding it is the check:
 * two starts racing both reach the ALTER, and the one that loses sees "duplicate column name", which is success.
 */
export const addColumnIfMissing = Effect.fn("SharedWorktrees.addColumnIfMissing")(function* (
  table: string,
  column: string,
  type: "INTEGER" | "TEXT" = "INTEGER",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql
    .unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    .pipe(
      Effect.catch((error) =>
        /duplicate column name/i.test(errorText(error)) ? Effect.void : Effect.fail(error),
      ),
    );
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
  // Where the official thread stood when it was copied.
  yield* addColumnIfMissing("fork_t3code_import_map", "source_version");
  yield* addColumnIfMissing("fork_t3code_import_map", "source_runs");
  // The thread's user-editable fields as the copy had them, to tell what was changed here since.
  yield* addColumnIfMissing("fork_t3code_import_map", "source_meta", "TEXT");
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
    // One permit orders destructive sections against `markShared`'s in-memory update.
    const permit = yield* Semaphore.make(1);
    const initial = yield* load;
    // `loaded: false` means the database's markers are unknown; `marked` still holds what this process was told.
    const state = yield* Ref.make({ loaded: initial !== null, marked: new Set(initial ?? []) });

    // Plain in-memory check: takes no permit, so a section can call it while holding the permit.
    const refusal: SharedWorktreePolicy["refusal"] = Effect.fn("SharedWorktrees.refusal")(
      function* (input) {
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
      },
    );

    return SharedWorktreePolicy.of({
      live: true,
      refusal,
      exclusive: Effect.fn("SharedWorktrees.exclusive")(function* <A, E, R>(
        input: { readonly cwd: string; readonly path: string },
        effect: (section: SharedWorktreeSection) => Effect.Effect<A, E, R>,
      ) {
        return yield* permit.withPermits(1)(checkedThenRun(refusal, input, effect));
      }),
      markShared: Effect.fn("SharedWorktrees.markShared")(function* (paths) {
        // The retried load is database I/O, so it stays outside the permit.
        const reloaded = (yield* Ref.get(state)).loaded ? null : yield* load;
        yield* permit.withPermits(1)(
          Ref.update(state, (current) => ({
            loaded: current.loaded || reloaded !== null,
            marked: new Set([...current.marked, ...(reloaded ?? []), ...paths]),
          })),
        );
      }),
    });
  }),
);

/** Runs a worktree removal only while the worktree is unshared, holding the policy's permit across check and removal. */
export const whileRemovable = Effect.fn("SharedWorktrees.whileRemovable")(function* <A, E, R>(
  input: { readonly operation: string; readonly cwd: string; readonly path: string },
  effect: (section: SharedWorktreeSection) => Effect.Effect<A, E, R>,
) {
  const policy = yield* SharedWorktreePolicy;
  return yield* policy.exclusive(input, effect).pipe(
    Effect.catchIf(
      (error): error is SharedWorktreeRefused => isSharedWorktreeRefused(error),
      (refused) =>
        Effect.fail(
          new GitCommandError({
            operation: input.operation,
            command: "git worktree remove",
            cwd: input.cwd,
            detail: refused.reason,
          }),
        ),
    ),
  );
});

/** Fails unless the token is a real section token whose section is still running. */
export const assertSectionLive = Effect.fn("SharedWorktrees.assertSectionLive")(function* (
  section: SharedWorktreeSection,
  input: { readonly operation: string; readonly cwd: string },
) {
  if (section instanceof Section && section.live) return;
  return yield* new GitCommandError({
    operation: input.operation,
    command: "git worktree remove",
    cwd: input.cwd,
    detail: "The shared-worktree check that allowed this removal is no longer in effect.",
  });
});
