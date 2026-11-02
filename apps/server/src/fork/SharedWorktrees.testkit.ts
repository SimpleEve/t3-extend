// fork: the real GitWorkflowService guard on top of a recording Git driver, for tests of callers that remove worktrees.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as SharedWorktrees from "./SharedWorktrees.ts";

const isGitCommandError = Schema.is(GitCommandError);

export const makeGuardedRemoveWorktree = (options: {
  readonly officialWorktreesDir: string;
  /** Paths an import marked as shared with official T3 Code. */
  readonly marked?: ReadonlyArray<string>;
}) => {
  /** Every removal the caller asked for. */
  const attempts: Array<string> = [];
  /** The removals that got past the guard and reached Git. */
  const reachedGit: Array<string> = [];
  const layer = GitWorkflowService.layer.pipe(
    Layer.provide(SharedWorktrees.layerWithOfficialWorktrees(options.officialWorktreesDir)),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          removeWorktree: (input) =>
            Effect.sync(() => {
              reachedGit.push(input.path);
            }),
        }),
        Layer.mock(GitManager.GitManager)({}),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  const removeWorktree: GitWorkflowService.GitWorkflowService["Service"]["removeWorktree"] = (
    input,
  ) =>
    Effect.gen(function* () {
      attempts.push(input.path);
      const sql = yield* SqlClient.SqlClient;
      for (const marked of options.marked ?? []) {
        yield* sql`INSERT OR IGNORE INTO fork_t3code_import_map
          (kind, source_id, target_id, state, imported_at)
          VALUES ('worktree', ${marked}, ${marked}, 'shared', 'now')`.pipe(Effect.orDie);
      }
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      return yield* workflow.removeWorktree(input);
    }).pipe(
      Effect.provide(layer),
      Effect.scoped,
      // The caller sees the guard's own error; setup failures are bugs in the test.
      Effect.catchIf((error) => !isGitCommandError(error), Effect.die),
    );
  return { removeWorktree, attempts, reachedGit };
};
