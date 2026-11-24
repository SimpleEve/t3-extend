import type { ScopedThreadRef } from "@t3tools/contracts";
import { BookmarkIcon } from "lucide-react";

import { useMessageBookmarkKind } from "./threadBookmarkState";

/**
 * A mark at the left of a message that carries a bookmark. The timeline clips what sits outside
 * its lane, so the mark lives inside it: a glyph in the free left side of a user's bubble row, and
 * a ribbon in the narrow padding beside an assistant's text.
 */
export function BookmarkMessageMarker({
  threadRef,
  messageId,
  role,
}: {
  threadRef: ScopedThreadRef | null;
  messageId: string;
  role: "user" | "assistant" | "system";
}) {
  const kind = useMessageBookmarkKind(threadRef, messageId);
  if (kind === "none") return null;
  return (
    <span className="relative block h-0 w-0" data-bookmark-marker={kind}>
      {role === "user" ? (
        <BookmarkIcon
          aria-hidden
          className="absolute start-1 top-3 size-3 fill-current text-muted-foreground/70"
        />
      ) : (
        <span
          aria-hidden
          className="absolute start-0 top-2 h-2.5 w-[3px] bg-muted-foreground/70 [clip-path:polygon(0_0,100%_0,100%_100%,50%_72%,0_100%)]"
        />
      )}
    </span>
  );
}
