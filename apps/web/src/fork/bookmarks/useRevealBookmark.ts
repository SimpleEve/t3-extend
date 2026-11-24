import { bookmarkCitation } from "@t3tools/client-runtime/state/thread-bookmarks";
import type { ScopedThreadRef, ThreadBookmark } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { assistantCitationNavigation } from "../../lib/assistantCitationNavigation";
import { useQuietThreadShell } from "../../state/entities";

/**
 * Opens the thread at a bookmark. It rides on citation navigation, which pages in older history,
 * scrolls the virtual list to the message, and highlights the marked text once.
 */
export function useRevealBookmark(threadRef: ScopedThreadRef) {
  const navigate = useNavigate();
  const sourceThread = useQuietThreadShell(threadRef)?.source ?? null;
  return (bookmark: ThreadBookmark) =>
    navigate(assistantCitationNavigation(bookmarkCitation(bookmark, threadRef), sourceThread));
}
