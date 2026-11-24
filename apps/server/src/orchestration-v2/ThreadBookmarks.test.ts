import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  THREAD_BOOKMARK_MAX_PER_THREAD,
  ThreadBookmarkId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ThreadBookmark,
} from "@t3tools/contracts";

import {
  decideThreadBookmark,
  threadBookmarkShellFields,
  type ThreadBookmarkCommand,
} from "./ThreadBookmarks.ts";

const threadId = ThreadId.make("thread-1");
const now = "2026-11-24T12:00:00.000Z";
const thread = (bookmarks?: ReadonlyArray<ThreadBookmark>) =>
  ({ id: threadId, ...(bookmarks === undefined ? {} : { bookmarks }) }) as OrchestrationV2AppThread;
const stored = (id: string, patch: Partial<ThreadBookmark> = {}): ThreadBookmark => ({
  id: ThreadBookmarkId.make(id),
  messageId: MessageId.make("message-1"),
  kind: "message",
  excerpt: "Hello",
  title: null,
  note: null,
  messageCreatedAt: "2026-11-24T10:00:00.000Z",
  createdAt: "2026-11-24T10:05:00.000Z",
  updatedAt: "2026-11-24T10:05:00.000Z",
  ...patch,
});
const add = (patch: Record<string, unknown> = {}) =>
  ({
    type: "thread.bookmark.add",
    threadId,
    bookmarkId: ThreadBookmarkId.make("new"),
    messageId: MessageId.make("message-1"),
    kind: "message",
    excerpt: "Hello",
    ...patch,
  }) as unknown as ThreadBookmarkCommand;
const messageCreatedAt = "2026-11-24T10:00:00.000Z";

describe("decideThreadBookmark", () => {
  it("snapshots the message's creation time and keeps a selection's range", () => {
    const decision = decideThreadBookmark({
      thread: thread(),
      command: add({ kind: "selection", excerpt: "ell", selectionStart: 1, selectionEnd: 4 }),
      messageCreatedAt,
      now,
    });
    expect(decision._tag === "Updated" && decision.thread.bookmarks).toEqual([
      expect.objectContaining({
        id: "new",
        kind: "selection",
        selectionStart: 1,
        selectionEnd: 4,
        messageCreatedAt,
        createdAt: now,
      }),
    ]);
  });

  it("refuses a message the thread does not hold, an empty range, and a full thread", () => {
    expect(
      decideThreadBookmark({ thread: thread(), command: add(), messageCreatedAt: null, now })._tag,
    ).toBe("Rejected");
    expect(
      decideThreadBookmark({
        thread: thread(),
        command: add({ kind: "selection", selectionStart: 4, selectionEnd: 4 }),
        messageCreatedAt,
        now,
      })._tag,
    ).toBe("Rejected");
    const full = Array.from({ length: THREAD_BOOKMARK_MAX_PER_THREAD }, (_, index) =>
      stored(`b${index}`, { messageId: MessageId.make(`message-${index}`) }),
    );
    expect(
      decideThreadBookmark({
        thread: thread(full),
        command: add({ excerpt: "Another" }),
        messageCreatedAt,
        now,
      })._tag,
    ).toBe("Rejected");
  });

  it("leaves a repeated add, and a remove of a gone bookmark, unchanged", () => {
    const held = thread([stored("old")]);
    expect(
      decideThreadBookmark({
        thread: held,
        command: add({ bookmarkId: ThreadBookmarkId.make("old") }),
        messageCreatedAt,
        now,
      })._tag,
    ).toBe("Unchanged");
    expect(decideThreadBookmark({ thread: held, command: add(), messageCreatedAt, now })._tag).toBe(
      "Unchanged",
    );
    expect(
      decideThreadBookmark({
        thread: held,
        command: {
          type: "thread.bookmark.remove",
          threadId,
          bookmarkId: ThreadBookmarkId.make("gone"),
        } as ThreadBookmarkCommand,
        messageCreatedAt: null,
        now,
      })._tag,
    ).toBe("Unchanged");
  });

  it("clears a title or note set to blank and ignores an update that changes nothing", () => {
    const held = thread([stored("old", { title: "Title", note: "Note" })]);
    const update = (patch: Record<string, unknown>) =>
      decideThreadBookmark({
        thread: held,
        command: {
          type: "thread.bookmark.update",
          threadId,
          bookmarkId: ThreadBookmarkId.make("old"),
          ...patch,
        } as ThreadBookmarkCommand,
        messageCreatedAt: null,
        now,
      });
    const cleared = update({ title: "   " });
    expect(cleared._tag === "Updated" && cleared.thread.bookmarks?.[0]?.title).toBeNull();
    expect(cleared._tag === "Updated" && cleared.thread.bookmarks?.[0]?.note).toBe("Note");
    expect(update({ title: "Title" })._tag).toBe("Unchanged");
  });
});

describe("threadBookmarkShellFields", () => {
  it("says nothing for a thread without bookmarks", () => {
    expect(threadBookmarkShellFields(undefined)).toEqual({});
    expect(threadBookmarkShellFields([])).toEqual({});
  });

  it("carries the count and short previews, never the excerpt", () => {
    const fields = threadBookmarkShellFields([stored("a", { excerpt: "x".repeat(500) })]);
    expect(fields.bookmarkCount).toBe(1);
    expect(fields.bookmarkPreviews?.[0]?.label.length).toBeLessThanOrEqual(41);
  });
});
