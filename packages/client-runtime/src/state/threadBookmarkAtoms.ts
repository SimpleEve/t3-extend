import type { ScopedThreadRef, ThreadBookmark } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { parseScopedThreadKey, scopedThreadKey } from "../environment/scoped.ts";
import type { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import {
  bookmarkSourceState,
  orderedThreadBookmarks,
  type BookmarkSourceState,
} from "./threadBookmarks.ts";

// fork: message bookmarks. Atoms over a thread's bookmarks, shared by web and mobile.

type ThreadDetails = Pick<
  ReturnType<typeof createEnvironmentThreadDetailAtoms<unknown>>,
  "quietThreadAtom" | "historyAtom"
>;

const NO_BOOKMARKS: ReadonlyArray<ThreadBookmark> = [];
const NO_SOURCES: ReadonlyMap<string, BookmarkSourceState> = new Map();

export type MessageBookmarkKind = "none" | "selection" | "message";

export function createThreadBookmarkAtoms(details: ThreadDetails) {
  // The thread structure holds through streamed text, and the array is replaced only by a
  // bookmark event, so readers re-render for bookmarks alone.
  const bookmarksFamily = Atom.family((key: string) => {
    const ref = parseScopedThreadKey(key);
    let raw: ReadonlyArray<ThreadBookmark> | undefined;
    let ordered = NO_BOOKMARKS;
    return Atom.make((get) => {
      const next =
        ref === null ? undefined : get(details.quietThreadAtom(ref))?.projection.thread.bookmarks;
      if (next === raw) return ordered;
      raw = next;
      ordered = orderedThreadBookmarks(next);
      return ordered;
    }).pipe(Atom.withLabel(`thread-bookmarks:${key}`));
  });

  const messageKindFamily = Atom.family((key: string) => {
    const separator = key.lastIndexOf("\u0000");
    const threadKey = key.slice(0, separator);
    const messageId = key.slice(separator + 1);
    return Atom.make((get): MessageBookmarkKind => {
      let kind: MessageBookmarkKind = "none";
      for (const bookmark of get(bookmarksFamily(threadKey))) {
        if (bookmark.messageId !== messageId) continue;
        if (bookmark.kind === "message") return "message";
        kind = "selection";
      }
      return kind;
    }).pipe(Atom.withLabel(`message-bookmark:${key}`));
  });

  // Whether each bookmark's message is in the loaded history, so it can be revealed.
  const sourcesFamily = Atom.family((key: string) => {
    const ref = parseScopedThreadKey(key);
    return Atom.make((get) => {
      if (ref === null) return NO_SOURCES;
      const bookmarks = get(bookmarksFamily(key));
      if (bookmarks.length === 0) return NO_SOURCES;
      const thread = get(details.quietThreadAtom(ref));
      const hasMoreHistory = get(details.historyAtom(ref)).hasMoreHistory;
      const loadedMessageIds = new Set<string>();
      for (const { item } of thread?.projection.visibleTurnItems ?? []) {
        if (item.type === "user_message" || item.type === "assistant_message") {
          loadedMessageIds.add(item.messageId);
        }
      }
      const states = new Map<string, BookmarkSourceState>();
      for (const bookmark of bookmarks) {
        // Nothing is known before the thread loads: the message may still be there.
        states.set(
          bookmark.id,
          thread === null
            ? "unknown"
            : bookmarkSourceState({ bookmark, loadedMessageIds, hasMoreHistory }),
        );
      }
      return states as ReadonlyMap<string, BookmarkSourceState>;
    }).pipe(Atom.withLabel(`bookmark-sources:${key}`));
  });

  return {
    bookmarksAtom: (ref: ScopedThreadRef) => bookmarksFamily(scopedThreadKey(ref)),
    messageKindAtom: (ref: ScopedThreadRef, messageId: string) =>
      messageKindFamily(`${scopedThreadKey(ref)}\u0000${messageId}`),
    sourcesAtom: (ref: ScopedThreadRef) => sourcesFamily(scopedThreadKey(ref)),
  };
}
