import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  THREAD_BOOKMARK_EXCERPT_MAX_LENGTH,
  compareThreadBookmarks,
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type ThreadBookmark,
  type ThreadId,
} from "@t3tools/contracts";

// fork: message bookmarks. What the web and mobile clients share about them: order, source state,
// and the citation that reveals a bookmark in the timeline.

/** What a client sends to add a bookmark; the id and the thread come from the caller. */
export interface ThreadBookmarkDraft {
  readonly messageId: MessageId;
  readonly kind: ThreadBookmark["kind"];
  readonly excerpt: string;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
  readonly selectionPrefix?: string;
  readonly selectionSuffix?: string;
}

const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ");

/** Cuts to `limit` UTF-16 units without leaving half of a surrogate pair. */
function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function orderedThreadBookmarks(
  bookmarks: ReadonlyArray<ThreadBookmark> | undefined,
): ReadonlyArray<ThreadBookmark> {
  return bookmarks === undefined || bookmarks.length === 0
    ? []
    : [...bookmarks].sort(compareThreadBookmarks);
}

export function wholeMessageBookmark(
  bookmarks: ReadonlyArray<ThreadBookmark>,
  messageId: string,
): ThreadBookmark | undefined {
  return bookmarks.find(
    (bookmark) => bookmark.kind === "message" && bookmark.messageId === messageId,
  );
}

/**
 * `present`: the message is in the loaded history. `unknown`: it may sit in history not loaded yet.
 * `missing`: all history is loaded and it is not there, so a rollback or a compaction removed it.
 */
export type BookmarkSourceState = "present" | "unknown" | "missing";

export function bookmarkSourceState(input: {
  readonly bookmark: Pick<ThreadBookmark, "messageId">;
  readonly loadedMessageIds: ReadonlySet<string>;
  readonly hasMoreHistory: boolean;
}): BookmarkSourceState {
  if (input.loadedMessageIds.has(input.bookmark.messageId)) return "present";
  return input.hasMoreHistory ? "unknown" : "missing";
}

/** A whole-message bookmark keeps the message's text as it rendered, so a reveal can find it. */
export function messageBookmarkDraft(input: {
  readonly messageId: MessageId;
  readonly renderedText: string;
  /** The message's own text, for a message that renders no text (an image alone). */
  readonly fallbackText: string;
}): ThreadBookmarkDraft | null {
  const rendered = input.renderedText.trim();
  const excerpt = cutText(
    rendered === "" ? input.fallbackText.trim() : rendered,
    THREAD_BOOKMARK_EXCERPT_MAX_LENGTH,
  );
  return excerpt === "" ? null : { messageId: input.messageId, kind: "message", excerpt };
}

export function selectionBookmarkDraft(input: {
  readonly messageId: MessageId;
  readonly selector: {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly prefix: string;
    readonly suffix: string;
  };
}): ThreadBookmarkDraft | null {
  const { selector } = input;
  if (selector.text.trim() === "" || selector.text.length > THREAD_BOOKMARK_EXCERPT_MAX_LENGTH) {
    return null;
  }
  return {
    messageId: input.messageId,
    kind: "selection",
    excerpt: selector.text,
    selectionStart: selector.start,
    selectionEnd: selector.end,
    selectionPrefix: selector.prefix,
    selectionSuffix: selector.suffix,
  };
}

/** The citation that makes the timeline scroll to a bookmark and highlight what it marks. */
export function bookmarkCitation(
  bookmark: ThreadBookmark,
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): AssistantCitation {
  const text = cutText(bookmark.excerpt, ASSISTANT_CITATION_MAX_TEXT_LENGTH);
  const length = normalizeWhitespace(text).length;
  const selection = bookmark.kind === "selection";
  const start = selection ? (bookmark.selectionStart ?? 0) : 0;
  const end = selection ? (bookmark.selectionEnd ?? start + length) : length;
  return {
    version: 1,
    ...thread,
    messageId: bookmark.messageId,
    text,
    start,
    end: end > start ? end : start + Math.max(1, length),
    prefix: selection ? (bookmark.selectionPrefix ?? "") : "",
    suffix: selection ? (bookmark.selectionSuffix ?? "") : "",
  };
}
