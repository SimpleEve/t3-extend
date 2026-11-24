import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  StoredThreadBookmarks,
  THREAD_BOOKMARK_PREVIEW_COUNT,
  ThreadBookmark as ThreadBookmarkSchema,
  compareThreadBookmarks,
  threadBookmarkLabel,
  type OrchestrationV2ThreadShell,
  type ThreadBookmark,
  type ThreadBookmarkChange,
  type ThreadId,
} from "@t3tools/contracts";

// fork: message bookmarks. Bookmarks live in their own table, one row per bookmark, so a thread's
// other events never carry them. The table is created at startup rather than by a numbered
// migration: the fork adds none, because a clash with an upstream id breaks the next sync.

const TABLE = "fork_thread_bookmarks";

const encodeBookmarkJson = Schema.encodeSync(Schema.fromJsonString(ThreadBookmarkSchema));
const encodeIdsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const ensureThreadBookmarkTable = Effect.fn("ThreadBookmarkStore.ensureTable")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    thread_id TEXT NOT NULL,
    bookmark_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_created_at TEXT NOT NULL,
    selection_start INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    label TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, bookmark_id)
  )`);
});

export const writeThreadBookmarkChange = Effect.fn("ThreadBookmarkStore.write")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  change: ThreadBookmarkChange,
) {
  if (change.kind === "remove") {
    yield* sql`DELETE FROM fork_thread_bookmarks
      WHERE thread_id = ${threadId} AND bookmark_id = ${change.bookmarkId}`;
    return;
  }
  const { bookmark } = change;
  yield* sql`
    INSERT INTO fork_thread_bookmarks (
      thread_id, bookmark_id, message_id, message_created_at, selection_start, created_at,
      label, payload_json
    )
    VALUES (
      ${threadId}, ${bookmark.id}, ${bookmark.messageId}, ${bookmark.messageCreatedAt},
      ${bookmark.selectionStart ?? -1}, ${bookmark.createdAt}, ${threadBookmarkLabel(bookmark)},
      ${encodeBookmarkJson(bookmark)}
    )
    ON CONFLICT(thread_id, bookmark_id) DO UPDATE SET
      label = excluded.label,
      payload_json = excluded.payload_json
  `;
});

/** Clearing is for a projection rebuild, which replays every bookmark event again. */
export const clearThreadBookmarks = (sql: SqlClient.SqlClient) =>
  sql.unsafe(`DELETE FROM ${TABLE}`).pipe(Effect.asVoid);

const decodeStored = Schema.decodeUnknownSync(StoredThreadBookmarks);

const parseRows = (rows: ReadonlyArray<{ readonly payload_json: string }>): Array<unknown> =>
  rows.flatMap((row) => {
    const parsed = parseJson(row.payload_json);
    return parsed._tag === "Some" ? [parsed.value] : [];
  });

/** A thread's bookmarks in conversation order. A row this build cannot read is skipped alone. */
export const readThreadBookmarks = Effect.fn("ThreadBookmarkStore.read")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM fork_thread_bookmarks WHERE thread_id = ${threadId}
  `;
  return [...decodeStored(parseRows(rows))].sort(compareThreadBookmarks);
});

type ShellBookmarkFields = Pick<OrchestrationV2ThreadShell, "bookmarkCount" | "bookmarkPreviews">;

/** The sidebar's count and short previews per thread, read without decoding any excerpt. */
export const readThreadBookmarkShellFields = Effect.fn("ThreadBookmarkStore.readShellFields")(
  function* (sql: SqlClient.SqlClient, threadIds: ReadonlyArray<ThreadId>) {
    const byThread = new Map<string, ShellBookmarkFields>();
    if (threadIds.length === 0) return byThread;
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly bookmark_id: string;
      readonly message_id: string;
      readonly message_created_at: string;
      readonly selection_start: number;
      readonly created_at: string;
      readonly label: string;
    }>`
      SELECT thread_id, bookmark_id, message_id, message_created_at, selection_start, created_at,
        label
      FROM fork_thread_bookmarks
      WHERE thread_id IN (SELECT value FROM json_each(${encodeIdsJson(threadIds)}))
    `;
    const grouped = Map.groupBy(rows, (row) => row.thread_id);
    for (const [threadId, group] of grouped) {
      const ordered = group
        .map((row) => ({
          id: row.bookmark_id,
          messageId: row.message_id,
          messageCreatedAt: row.message_created_at,
          selectionStart: row.selection_start < 0 ? undefined : row.selection_start,
          createdAt: row.created_at,
          label: row.label,
        }))
        .sort(compareThreadBookmarks);
      byThread.set(threadId, {
        bookmarkCount: ordered.length,
        bookmarkPreviews: ordered
          .slice(0, THREAD_BOOKMARK_PREVIEW_COUNT)
          .map((entry) => ({ id: entry.id as ThreadBookmark["id"], label: entry.label })),
      });
    }
    return byThread;
  },
);
