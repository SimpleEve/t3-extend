import { messageBookmarkDraft } from "@t3tools/client-runtime/state/thread-bookmarks";
import { MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BookmarkIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { findMessageTextSource, readRenderedMessageText } from "../../lib/assistantTextSelection";
import { useMessageBookmarkKind, useThreadBookmarks } from "./threadBookmarkState";
import { useThreadBookmarkActions } from "./useThreadBookmarkActions";

/** On a message's hover bar: bookmarks the whole message, or takes that bookmark away. */
export function BookmarkMessageButton({
  threadRef,
  messageId,
  fallbackText,
}: {
  threadRef: ScopedThreadRef;
  messageId: string;
  fallbackText: string;
}) {
  const gt = useGT();
  const kind = useMessageBookmarkKind(threadRef, messageId);
  const bookmarks = useThreadBookmarks(threadRef);
  const actions = useThreadBookmarkActions(threadRef);
  const bookmarked = kind === "message";
  const label = bookmarked ? gt("Remove bookmark") : gt("Bookmark this message");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={bookmarked}
            onClick={() =>
              void actions.toggleMessage(bookmarks, messageId, () =>
                messageBookmarkDraft({
                  messageId: MessageId.make(messageId),
                  // The row can be virtualized away from a meta row below it.
                  renderedText: readRenderedMessageText(
                    findMessageTextSource(document, threadRef, messageId),
                  ),
                  fallbackText,
                }),
              )
            }
          />
        }
      >
        <BookmarkIcon className={bookmarked ? "size-3 fill-current" : "size-3"} />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
