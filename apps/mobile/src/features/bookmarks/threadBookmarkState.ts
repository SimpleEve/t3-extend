import { useAtomValue } from "@effect/atom-react";
import { createThreadBookmarkAtoms } from "@t3tools/client-runtime/state/thread-bookmark-atoms";
import type { BookmarkSourceState } from "@t3tools/client-runtime/state/thread-bookmarks";
import type { ScopedThreadRef, ThreadBookmark } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "../../state/threads";

// fork: message bookmarks
const atoms = createThreadBookmarkAtoms(environmentThreadDetails);
const NO_BOOKMARKS_ATOM = Atom.make<ReadonlyArray<ThreadBookmark>>([]);
const NO_SOURCES_ATOM = Atom.make<ReadonlyMap<string, BookmarkSourceState>>(new Map());

/** The thread's bookmarks in conversation order; empty until its detail has loaded. */
export function useThreadBookmarks(ref: ScopedThreadRef | null): ReadonlyArray<ThreadBookmark> {
  return useAtomValue(ref === null ? NO_BOOKMARKS_ATOM : atoms.bookmarksAtom(ref));
}

export function useBookmarkSources(
  ref: ScopedThreadRef | null,
): ReadonlyMap<string, BookmarkSourceState> {
  return useAtomValue(ref === null ? NO_SOURCES_ATOM : atoms.sourcesAtom(ref));
}
