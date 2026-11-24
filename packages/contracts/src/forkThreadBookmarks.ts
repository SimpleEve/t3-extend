import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ASSISTANT_CITATION_CONTEXT_LENGTH } from "./assistantCitations.ts";
import { MessageId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// fork: a bookmark marks one message, or a passage inside it, so it can be found again. It lives on
// the thread, so every device sees it. The excerpt is a snapshot: a bookmark outlives the message it
// points at, which a rollback or a compaction can remove. Bookmarks have their own event and table;
// no other thread event carries them.

/** One bookmark is one event and one row, so these limits bound that, not every thread event. */
export const THREAD_BOOKMARK_EXCERPT_MAX_LENGTH = 10_000;
export const THREAD_BOOKMARK_TITLE_MAX_LENGTH = 200;
export const THREAD_BOOKMARK_NOTE_MAX_LENGTH = 4_000;
export const THREAD_BOOKMARK_MAX_PER_THREAD = 100;
/** The sidebar summary carries at most this many previews of this many characters. */
export const THREAD_BOOKMARK_PREVIEW_COUNT = 5;
const THREAD_BOOKMARK_PREVIEW_MAX_LENGTH = 40;

export const ThreadBookmarkId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ThreadBookmarkId"),
);
export type ThreadBookmarkId = typeof ThreadBookmarkId.Type;

export const ThreadBookmarkKind = Schema.Literals(["message", "selection"]);
export type ThreadBookmarkKind = typeof ThreadBookmarkKind.Type;

const ThreadBookmarkTitle = Schema.String.check(
  Schema.isMaxLength(THREAD_BOOKMARK_TITLE_MAX_LENGTH),
  Schema.makeFilter((value) =>
    /[\p{Cc}]/u.test(value) ? "A bookmark title must be a single line of text." : true,
  ),
);
const ThreadBookmarkNote = Schema.String.check(Schema.isMaxLength(THREAD_BOOKMARK_NOTE_MAX_LENGTH));

export const ThreadBookmark = Schema.Struct({
  id: ThreadBookmarkId,
  messageId: MessageId,
  kind: ThreadBookmarkKind,
  /** The whole message for `message`, the selected text for `selection`. */
  excerpt: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THREAD_BOOKMARK_EXCERPT_MAX_LENGTH),
  ),
  /**
   * Where a selection sat in the rendered message text, as an assistant citation records it:
   * UTF-16 offsets plus a little context either side, which find the passage again after a
   * re-render shifts the offsets.
   */
  selectionStart: Schema.optional(NonNegativeInt),
  selectionEnd: Schema.optional(NonNegativeInt),
  selectionPrefix: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
  ),
  selectionSuffix: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
  ),
  title: Schema.NullOr(ThreadBookmarkTitle),
  note: Schema.NullOr(ThreadBookmarkNote),
  /** The message's own creation time, kept so bookmarks sort in conversation order without it. */
  messageCreatedAt: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ThreadBookmark = typeof ThreadBookmark.Type;

const decodeBookmarkOption = Schema.decodeUnknownOption(ThreadBookmark);

/**
 * Bookmarks read back from storage or a peer, one by one: a bookmark a later rule can no longer
 * read is dropped on its own, and the rest of the thread's bookmarks stay.
 */
export const StoredThreadBookmarks = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(ThreadBookmark),
    SchemaTransformation.transform<
      ReadonlyArray<(typeof ThreadBookmark)["Encoded"]>,
      ReadonlyArray<unknown>
    >({
      decode: (raw) =>
        raw.filter((entry) => Option.isSome(decodeBookmarkOption(entry))) as ReadonlyArray<
          (typeof ThreadBookmark)["Encoded"]
        >,
      encode: (bookmarks) => bookmarks,
    }),
  ),
);

/** What one bookmark command changes; the event carries this and never the whole list. */
export const ThreadBookmarkChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("upsert"), bookmark: ThreadBookmark }),
  Schema.Struct({ kind: Schema.Literal("remove"), bookmarkId: ThreadBookmarkId }),
]);
export type ThreadBookmarkChange = typeof ThreadBookmarkChange.Type;

/** Apply a change to a thread's bookmarks; an upsert of a known id replaces it in place. */
export function applyThreadBookmarkChange(
  bookmarks: ReadonlyArray<ThreadBookmark>,
  change: ThreadBookmarkChange,
): ReadonlyArray<ThreadBookmark> {
  if (change.kind === "remove") {
    return bookmarks.filter((bookmark) => bookmark.id !== change.bookmarkId);
  }
  return bookmarks.some((bookmark) => bookmark.id === change.bookmark.id)
    ? bookmarks.map((bookmark) => (bookmark.id === change.bookmark.id ? change.bookmark : bookmark))
    : [...bookmarks, change.bookmark];
}

/** What the sidebar summary carries per bookmark; the full text stays in the thread detail. */
export const ThreadBookmarkPreview = Schema.Struct({
  id: ThreadBookmarkId,
  // Counted in UTF-16 units, so a label of astral characters still fits.
  label: Schema.String.check(Schema.isMaxLength(THREAD_BOOKMARK_PREVIEW_MAX_LENGTH * 2 + 2)),
});
export type ThreadBookmarkPreview = typeof ThreadBookmarkPreview.Type;

export const ThreadBookmarkAddFields = {
  bookmarkId: ThreadBookmarkId,
  messageId: MessageId,
  kind: ThreadBookmarkKind,
  excerpt: ThreadBookmark.fields.excerpt,
  selectionStart: ThreadBookmark.fields.selectionStart,
  selectionEnd: ThreadBookmark.fields.selectionEnd,
  selectionPrefix: ThreadBookmark.fields.selectionPrefix,
  selectionSuffix: ThreadBookmark.fields.selectionSuffix,
  title: Schema.optional(ThreadBookmark.fields.title),
  note: Schema.optional(ThreadBookmark.fields.note),
  /** Undo re-adds a removed bookmark with its original creation time. */
  createdAt: Schema.optional(Schema.String),
} as const;

export const ThreadBookmarkUpdateFields = {
  bookmarkId: ThreadBookmarkId,
  title: Schema.optional(ThreadBookmark.fields.title),
  note: Schema.optional(ThreadBookmark.fields.note),
} as const;

/** One line of at most `maxLength` characters, cut on a character boundary with an ellipsis. */
export function threadBookmarkLabel(
  bookmark: Pick<ThreadBookmark, "title" | "excerpt">,
  maxLength: number = THREAD_BOOKMARK_PREVIEW_MAX_LENGTH,
): string {
  const text = (bookmark.title?.trim() ? bookmark.title : bookmark.excerpt)
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(text);
  return characters.length <= maxLength
    ? text
    : `${characters.slice(0, maxLength).join("").trimEnd()}…`;
}

type ThreadBookmarkOrderKey = {
  readonly id: string;
  readonly messageId: string;
  readonly messageCreatedAt: string;
  readonly createdAt: string;
  readonly selectionStart?: number | undefined;
};

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Conversation order: the message's position, then where the selection starts in it. */
export function compareThreadBookmarks(
  left: ThreadBookmarkOrderKey,
  right: ThreadBookmarkOrderKey,
): number {
  return (
    compareText(left.messageCreatedAt, right.messageCreatedAt) ||
    compareText(left.messageId, right.messageId) ||
    (left.selectionStart ?? -1) - (right.selectionStart ?? -1) ||
    compareText(left.createdAt, right.createdAt) ||
    compareText(left.id, right.id)
  );
}

export function threadBookmarkPreviews(
  bookmarks: ReadonlyArray<ThreadBookmark>,
): ReadonlyArray<ThreadBookmarkPreview> {
  return [...bookmarks]
    .sort(compareThreadBookmarks)
    .slice(0, THREAD_BOOKMARK_PREVIEW_COUNT)
    .map((bookmark) => ({ id: bookmark.id, label: threadBookmarkLabel(bookmark) }));
}
