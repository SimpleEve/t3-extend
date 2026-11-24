import {
  EnvironmentId,
  MessageId,
  ThreadBookmarkId,
  ThreadId,
  type ThreadBookmark,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bookmarkCitation,
  bookmarkSourceState,
  messageBookmarkDraft,
  orderedThreadBookmarks,
  selectionBookmarkDraft,
} from "./threadBookmarks.ts";

const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const bookmark = (patch: Partial<ThreadBookmark> = {}): ThreadBookmark => ({
  id: ThreadBookmarkId.make("b"),
  messageId: MessageId.make("m"),
  kind: "message",
  excerpt: "Hello  world\nagain",
  title: null,
  note: null,
  messageCreatedAt: "2026-11-24T10:00:00.000Z",
  createdAt: "2026-11-24T10:00:00.000Z",
  updatedAt: "2026-11-24T10:00:00.000Z",
  ...patch,
});

describe("thread bookmarks on the client", () => {
  it("tells a removed message from one in history not loaded yet", () => {
    const input = { bookmark: bookmark(), loadedMessageIds: new Set(["m"]), hasMoreHistory: true };
    expect(bookmarkSourceState(input)).toBe("present");
    expect(bookmarkSourceState({ ...input, loadedMessageIds: new Set() })).toBe("unknown");
    expect(
      bookmarkSourceState({ ...input, loadedMessageIds: new Set(), hasMoreHistory: false }),
    ).toBe("missing");
  });

  it("reveals a whole message as the rendered text from its start", () => {
    const citation = bookmarkCitation(bookmark(), thread);
    expect(citation).toMatchObject({ text: "Hello  world\nagain", start: 0, end: 17 });
    expect(citation.prefix + citation.suffix).toBe("");
  });

  it("reveals a selection by the offsets and context it was captured with", () => {
    const citation = bookmarkCitation(
      bookmark({
        kind: "selection",
        excerpt: "world",
        selectionStart: 6,
        selectionEnd: 11,
        selectionPrefix: "Hello ",
        selectionSuffix: " again",
      }),
      thread,
    );
    expect(citation).toMatchObject({ start: 6, end: 11, prefix: "Hello ", suffix: " again" });
  });

  it("keeps a long excerpt within what a citation and a bookmark allow", () => {
    const long = "x".repeat(12_000);
    const draft = messageBookmarkDraft({
      messageId: MessageId.make("m"),
      renderedText: long,
      fallbackText: "",
    });
    expect(draft?.excerpt).toHaveLength(10_000);
    expect(bookmarkCitation(bookmark({ excerpt: draft!.excerpt }), thread).text).toHaveLength(
      8_000,
    );
    expect(
      selectionBookmarkDraft({
        messageId: MessageId.make("m"),
        selector: { text: long, start: 0, end: 12_000, prefix: "", suffix: "" },
      }),
    ).toBeNull();
  });

  it("falls back to the message's own text when nothing rendered, and refuses an empty one", () => {
    const messageId = MessageId.make("m");
    expect(
      messageBookmarkDraft({ messageId, renderedText: "  ", fallbackText: "raw text" })?.excerpt,
    ).toBe("raw text");
    expect(messageBookmarkDraft({ messageId, renderedText: "", fallbackText: " " })).toBeNull();
  });

  it("orders a thread's bookmarks without touching the stored array", () => {
    const late = bookmark({
      id: ThreadBookmarkId.make("late"),
      messageCreatedAt: "2026-11-24T11:00:00.000Z",
    });
    const early = bookmark({ id: ThreadBookmarkId.make("early") });
    const stored = [late, early];
    expect(orderedThreadBookmarks(stored).map((entry) => entry.id)).toEqual(["early", "late"]);
    expect(stored[0]).toBe(late);
  });
});
