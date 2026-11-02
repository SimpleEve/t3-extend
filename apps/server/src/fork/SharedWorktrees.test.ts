import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SharedWorktrees from "./SharedWorktrees.ts";
import { makeGuardedRemoveWorktree } from "./SharedWorktrees.testkit.ts";

it.layer(NodeServices.layer)("SharedWorktrees", (it) => {
  it.effect("refuses what official T3 Code owns and lets the rest through to Git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-worktrees-" });
      const official = path.join(root, "official", "worktrees");
      const marked = path.join(root, "elsewhere", "marked");
      yield* fs.makeDirectory(path.join(official, "repo", "feature"), { recursive: true });
      yield* fs.symlink(official, path.join(root, "link"));
      const guarded = makeGuardedRemoveWorktree({
        officialWorktreesDir: official,
        marked: [marked],
      });
      const cwd = path.join(root, "repo");

      const refused = [
        path.join(official, "repo", "feature"),
        path.join(official, "never-created"),
        official,
        path.join(root, "link", "repo", "feature"),
        marked,
      ];
      for (const target of refused) {
        const exit = yield* Effect.exit(guarded.removeWorktree({ cwd, path: target, force: true }));
        assert.isTrue(Exit.isFailure(exit), `${target} should be refused`);
      }
      assert.deepStrictEqual(guarded.reachedGit, []);

      const allowed = [
        path.join(root, "mine", "feature"),
        path.join(root, "official", "worktrees-extra", "x"),
      ];
      for (const target of allowed) {
        yield* guarded.removeWorktree({ cwd, path: target, force: true });
      }
      assert.deepStrictEqual(guarded.reachedGit, allowed);
    }),
  );

  it.effect("sets its tables up twice without error", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* SharedWorktrees.ensureImportTables();
      yield* SharedWorktrees.ensureImportTables();
      yield* sql`INSERT INTO fork_t3code_import_map (kind, source_id, target_id, state, imported_at)
        VALUES ('thread', 'a', 'b', 'done', 'now')`;
      // A second start of the service must keep what the first one stored.
      yield* Effect.scoped(Layer.build(SharedWorktrees.layerWithOfficialWorktrees("/official")));
      const [row] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM fork_t3code_import_map`;
      assert.equal(row?.count, 1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
