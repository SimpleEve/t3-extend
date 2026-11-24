import {
  THREAD_BOOKMARK_MAX_PER_THREAD,
  threadBookmarkPreviews,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type ThreadBookmark,
} from "@t3tools/contracts";

// fork: message bookmarks. The decision is a pure function of the thread, so the orchestrator
// only has to look up the bookmarked message and emit the event.

export type ThreadBookmarkCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type: "thread.bookmark.add" | "thread.bookmark.update" | "thread.bookmark.remove";
  }
>;

export const isThreadBookmarkCommand = (
  command: OrchestrationV2ServerCommand,
): command is ThreadBookmarkCommand =>
  command.type === "thread.bookmark.add" ||
  command.type === "thread.bookmark.update" ||
  command.type === "thread.bookmark.remove";

export type ThreadBookmarkDecision =
  | { readonly _tag: "Updated"; readonly thread: OrchestrationV2AppThread }
  /** Nothing to change: an add repeated by retry or a second device, or a remove of a gone one. */
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Rejected"; readonly reason: string };

export function decideThreadBookmark(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: ThreadBookmarkCommand;
  /** The bookmarked message's creation time, or null when the thread has no such message. */
  readonly messageCreatedAt: string | null;
  readonly now: string;
}): ThreadBookmarkDecision {
  const { thread, command, now } = input;
  const bookmarks = thread.bookmarks ?? [];
  const withBookmarks = (next: ReadonlyArray<ThreadBookmark>): ThreadBookmarkDecision => ({
    _tag: "Updated",
    thread: { ...thread, bookmarks: next },
  });
  switch (command.type) {
    case "thread.bookmark.add": {
      if (bookmarks.some((bookmark) => bookmark.id === command.bookmarkId)) {
        return { _tag: "Unchanged" };
      }
      if (input.messageCreatedAt === null) {
        return {
          _tag: "Rejected",
          reason: `Message ${command.messageId} is not in thread ${thread.id}.`,
        };
      }
      if (command.kind === "selection" && !selectionRangeIsValid(command)) {
        return { _tag: "Rejected", reason: "A bookmarked selection needs a valid text range." };
      }
      // A message or passage is bookmarked once: a second device pressing the same button must
      // not stack a duplicate on the first one's.
      const duplicate = bookmarks.some(
        (bookmark) =>
          bookmark.messageId === command.messageId &&
          bookmark.kind === command.kind &&
          bookmark.excerpt === command.excerpt,
      );
      if (duplicate) return { _tag: "Unchanged" };
      if (bookmarks.length >= THREAD_BOOKMARK_MAX_PER_THREAD) {
        return {
          _tag: "Rejected",
          reason: `A thread holds at most ${THREAD_BOOKMARK_MAX_PER_THREAD} bookmarks.`,
        };
      }
      return withBookmarks([
        ...bookmarks,
        {
          id: command.bookmarkId,
          messageId: command.messageId,
          kind: command.kind,
          excerpt: command.excerpt,
          ...(command.kind === "selection" && command.selectionStart !== undefined
            ? { selectionStart: command.selectionStart }
            : {}),
          ...(command.kind === "selection" && command.selectionEnd !== undefined
            ? { selectionEnd: command.selectionEnd }
            : {}),
          ...(command.kind === "selection" && command.selectionPrefix !== undefined
            ? { selectionPrefix: command.selectionPrefix }
            : {}),
          ...(command.kind === "selection" && command.selectionSuffix !== undefined
            ? { selectionSuffix: command.selectionSuffix }
            : {}),
          title: command.title ?? null,
          note: command.note ?? null,
          messageCreatedAt: input.messageCreatedAt,
          createdAt: command.createdAt ?? now,
          updatedAt: now,
        },
      ]);
    }
    case "thread.bookmark.update": {
      const current = bookmarks.find((bookmark) => bookmark.id === command.bookmarkId);
      if (current === undefined) {
        return { _tag: "Rejected", reason: `Bookmark ${command.bookmarkId} does not exist.` };
      }
      const title = command.title === undefined ? current.title : blankToNull(command.title);
      const note = command.note === undefined ? current.note : blankToNull(command.note);
      if (title === current.title && note === current.note) return { _tag: "Unchanged" };
      return withBookmarks(
        bookmarks.map((bookmark) =>
          bookmark.id === current.id ? { ...bookmark, title, note, updatedAt: now } : bookmark,
        ),
      );
    }
    case "thread.bookmark.remove": {
      if (!bookmarks.some((bookmark) => bookmark.id === command.bookmarkId)) {
        return { _tag: "Unchanged" };
      }
      return withBookmarks(bookmarks.filter((bookmark) => bookmark.id !== command.bookmarkId));
    }
  }
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function selectionRangeIsValid(command: {
  readonly selectionStart?: number | undefined;
  readonly selectionEnd?: number | undefined;
}): boolean {
  return (
    command.selectionStart === undefined ||
    command.selectionEnd === undefined ||
    command.selectionEnd > command.selectionStart
  );
}

/** The shell row carries the count and short previews; the excerpts stay in the thread detail. */
export function threadBookmarkShellFields(bookmarks: ReadonlyArray<ThreadBookmark> | undefined) {
  return bookmarks === undefined || bookmarks.length === 0
    ? {}
    : { bookmarkCount: bookmarks.length, bookmarkPreviews: threadBookmarkPreviews(bookmarks) };
}
