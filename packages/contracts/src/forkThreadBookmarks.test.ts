import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  StoredThreadBookmarks,
  THREAD_BOOKMARK_EXCERPT_MAX_LENGTH,
  THREAD_BOOKMARK_PREVIEW_COUNT,
  ThreadBookmarkId,
  applyThreadBookmarkChange,
  compareThreadBookmarks,
  threadBookmarkLabel,
  threadBookmarkPreviews,
  type ThreadBookmark,
} from "./forkThreadBookmarks.ts";
import { MessageId } from "./baseSchemas.ts";

const bookmark = (id: string, patch: Partial<ThreadBookmark> = {}): ThreadBookmark => ({
  id: ThreadBookmarkId.make(id),
  messageId: MessageId.make("message-1"),
  kind: "message",
  excerpt: "Some text",
  title: null,
  note: null,
  messageCreatedAt: "2026-11-24T10:00:00.000Z",
  createdAt: "2026-11-24T10:05:00.000Z",
  updatedAt: "2026-11-24T10:05:00.000Z",
  ...patch,
});

describe("thread bookmarks", () => {
  it("labels with the title first, then the excerpt, on one cut line", () => {
    expect(threadBookmarkLabel(bookmark("a", { title: "  My title " }))).toBe("My title");
    expect(threadBookmarkLabel(bookmark("a", { title: "  ", excerpt: "one\n\n two\tthree" }))).toBe(
      "one two three",
    );
    const cut = threadBookmarkLabel(bookmark("a", { excerpt: "x".repeat(60) }));
    expect(cut).toBe(`${"x".repeat(40)}…`);
    // A character outside the BMP is one character, never half of a pair.
    expect(threadBookmarkLabel(bookmark("a", { excerpt: "😀".repeat(50) }))).toBe(
      `${"😀".repeat(40)}…`,
    );
  });

  it("orders by message, then selection start, then creation", () => {
    const early = bookmark("early", { messageCreatedAt: "2026-11-24T09:00:00.000Z" });
    const lateWhole = bookmark("late-whole", { messageId: MessageId.make("message-2") });
    const lateSecond = bookmark("late-b", {
      messageId: MessageId.make("message-2"),
      kind: "selection",
      selectionStart: 40,
    });
    const lateFirst = bookmark("late-a", {
      messageId: MessageId.make("message-2"),
      kind: "selection",
      selectionStart: 5,
      createdAt: "2026-11-24T11:00:00.000Z",
    });
    expect(
      [lateSecond, lateFirst, lateWhole, early]
        .sort(compareThreadBookmarks)
        .map((entry) => entry.id),
    ).toEqual(["early", "late-whole", "late-a", "late-b"].map((id) => ThreadBookmarkId.make(id)));
  });

  it("previews only the first few in order", () => {
    const many = Array.from({ length: THREAD_BOOKMARK_PREVIEW_COUNT + 3 }, (_, index) =>
      bookmark(`b${index}`, { messageCreatedAt: `2026-11-24T10:0${index}:00.000Z` }),
    );
    expect(threadBookmarkPreviews([...many].reverse()).map((preview) => preview.id)).toEqual(
      many.slice(0, THREAD_BOOKMARK_PREVIEW_COUNT).map((entry) => entry.id),
    );
  });

  it("drops only the stored bookmark it cannot read, and keeps the rest in place", () => {
    const decode = Schema.decodeUnknownSync(StoredThreadBookmarks);
    const tooLong = bookmark("too-long", {
      excerpt: "x".repeat(THREAD_BOOKMARK_EXCERPT_MAX_LENGTH + 1),
    });
    const readable = [bookmark("a"), bookmark("b", { title: "Kept", note: "My note" })];
    const decoded = decode([readable[0], tooLong, { id: "garbage" }, null, readable[1]]);
    expect(decoded.map((entry) => entry.id)).toEqual(readable.map((entry) => entry.id));
    expect(decoded[1]?.note).toBe("My note");
    expect(decode([])).toEqual([]);
  });

  it("upserts in place and removes by id", () => {
    const first = bookmark("a");
    const second = bookmark("b");
    const edited = { ...first, title: "Edited" };
    expect(
      applyThreadBookmarkChange([first, second], { kind: "upsert", bookmark: edited }),
    ).toEqual([edited, second]);
    expect(
      applyThreadBookmarkChange([first], { kind: "upsert", bookmark: second }).map(
        (entry) => entry.id,
      ),
    ).toEqual([first.id, second.id]);
    expect(
      applyThreadBookmarkChange([first, second], { kind: "remove", bookmarkId: first.id }),
    ).toEqual([second]);
  });
});
