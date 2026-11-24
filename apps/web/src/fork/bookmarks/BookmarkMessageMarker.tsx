import type { ScopedThreadRef } from "@t3tools/contracts";
import { BookmarkIcon } from "lucide-react";

import { useMessageBookmarkKind } from "./threadBookmarkState";

/** A small mark at the left of a message that carries a bookmark. */
export function BookmarkMessageMarker({
  threadRef,
  messageId,
}: {
  threadRef: ScopedThreadRef | null;
  messageId: string;
}) {
  const kind = useMessageBookmarkKind(threadRef, messageId);
  if (kind === "none") return null;
  return (
    <span className="relative block h-0 w-0" data-bookmark-marker={kind}>
      <BookmarkIcon
        aria-hidden
        className="absolute -start-4 top-2 size-3 text-muted-foreground/70 fill-current"
      />
    </span>
  );
}
