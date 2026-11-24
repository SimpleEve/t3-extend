import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  THREAD_BOOKMARK_PREVIEW_COUNT,
  ThreadBookmarkId,
  ThreadId,
  type ThreadBookmark,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import {
  ensureThreadBookmarkTable,
  readThreadBookmarkShellFields,
  readThreadBookmarks,
  writeThreadBookmarkChange,
} from "./ThreadBookmarkStore.ts";

const threadId = ThreadId.make("bookmark-store-thread");
const bookmark = (id: string, patch: Partial<ThreadBookmark> = {}): ThreadBookmark => ({
  id: ThreadBookmarkId.make(id),
  messageId: MessageId.make("message-1"),
  kind: "message",
  excerpt: `Text of ${id}`,
  title: null,
  note: null,
  messageCreatedAt: "2026-11-24T10:00:00.000Z",
  createdAt: "2026-11-24T10:05:00.000Z",
  updatedAt: "2026-11-24T10:05:00.000Z",
  ...patch,
});

it.layer(Sqlite.layerMemory)("ThreadBookmarkStore", (it) => {
  it.effect("keeps every readable bookmark when one stored row cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureThreadBookmarkTable(sql);
      const first = bookmark("a", { note: "My note" });
      const second = bookmark("b", { messageCreatedAt: "2026-11-24T11:00:00.000Z" });
      yield* writeThreadBookmarkChange(sql, threadId, { kind: "upsert", bookmark: first });
      yield* writeThreadBookmarkChange(sql, threadId, { kind: "upsert", bookmark: second });
      yield* sql`
        INSERT INTO fork_thread_bookmarks (
          thread_id, bookmark_id, message_id, message_created_at, selection_start, created_at,
          label, payload_json
        ) VALUES
          (${threadId}, 'broken', 'message-1', '2026-11-24T10:30:00.000Z', -1, 'x', 'broken', '{"id":"broken"}'),
          (${threadId}, 'not-json', 'message-1', '2026-11-24T10:40:00.000Z', -1, 'x', 'not-json', '{')
      `;

      assert.deepEqual(
        (yield* readThreadBookmarks(sql, threadId)).map((entry) => entry.id),
        [first.id, second.id],
      );
      assert.equal(
        (yield* readThreadBookmarks(sql, threadId)).find((entry) => entry.id === first.id)?.note,
        "My note",
      );
      // Reading never writes anything back: the unreadable rows are skipped, not deleted.
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM fork_thread_bookmarks WHERE thread_id = ${threadId}
      `;
      assert.equal(rows[0]?.count, 4);
    }),
  );

  it.effect("upserts and removes rows, and gives the shell a count and ordered previews", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureThreadBookmarkTable(sql);
      const other = ThreadId.make("bookmark-store-other-thread");
      const many = Array.from({ length: THREAD_BOOKMARK_PREVIEW_COUNT + 2 }, (_, index) =>
        bookmark(`m${index}`, { messageCreatedAt: `2026-11-24T10:0${index}:00.000Z` }),
      );
      for (const entry of [...many].reverse()) {
        yield* writeThreadBookmarkChange(sql, other, { kind: "upsert", bookmark: entry });
      }
      yield* writeThreadBookmarkChange(sql, other, {
        kind: "upsert",
        bookmark: { ...many[0]!, title: "Renamed" },
      });

      const fields = (yield* readThreadBookmarkShellFields(sql, [other])).get(other);
      assert.equal(fields?.bookmarkCount, many.length);
      assert.deepEqual(
        fields?.bookmarkPreviews?.map((preview) => preview.id),
        many.slice(0, THREAD_BOOKMARK_PREVIEW_COUNT).map((entry) => entry.id),
      );
      assert.equal(fields?.bookmarkPreviews?.[0]?.label, "Renamed");

      yield* writeThreadBookmarkChange(sql, other, { kind: "remove", bookmarkId: many[0]!.id });
      assert.equal(
        (yield* readThreadBookmarkShellFields(sql, [other])).get(other)?.bookmarkCount,
        many.length - 1,
      );
      assert.isUndefined(
        (yield* readThreadBookmarkShellFields(sql, [ThreadId.make("none")])).get(other),
      );
    }),
  );

  // The import reads official T3 Code's database read-only, through the same store layer.
  it.effect("leaves a read-only database as it is instead of failing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bookmark-readonly-" });
      const filename = path.join(dir, "official.sqlite");
      yield* SqlClient.SqlClient.pipe(
        Effect.flatMap((sql) => sql`CREATE TABLE unrelated (id INTEGER)`),
        Effect.provide(NodeSqliteClient.layer({ filename })),
        Effect.scoped,
      );
      const tables = yield* SqlClient.SqlClient.pipe(
        Effect.flatMap((sql) =>
          ensureThreadBookmarkTable(sql).pipe(
            Effect.andThen(
              sql<{ readonly name: string }>`
                SELECT name FROM sqlite_master WHERE name = 'fork_thread_bookmarks'`,
            ),
          ),
        ),
        Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })),
        Effect.scoped,
      );
      assert.equal(tables.length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
