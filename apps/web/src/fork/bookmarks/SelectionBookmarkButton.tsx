import { selectionBookmarkDraft } from "@t3tools/client-runtime/state/thread-bookmarks";
import {
  AuthOrchestrationOperateScope,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BookmarkIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { useEnvironmentScope } from "../../state/session";
import { useThreadBookmarkActions } from "./useThreadBookmarkActions";

/** Beside "Cite" on the selection toolbar: bookmarks the selected passage. */
export function SelectionBookmarkButton({
  threadRef,
  citation,
  onDone,
}: {
  threadRef: ScopedThreadRef;
  citation: AssistantCitation;
  /** Called once the bookmark is on its way, so the toolbar can go. */
  onDone: () => void;
}) {
  const gt = useGT();
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const actions = useThreadBookmarkActions(threadRef);
  if (!canOperate) return null;
  const draft = selectionBookmarkDraft({
    messageId: MessageId.make(citation.messageId),
    selector: {
      text: citation.text,
      start: citation.start,
      end: citation.end,
      prefix: citation.prefix,
      suffix: citation.suffix,
    },
  });
  return (
    <Button
      type="button"
      size="xs"
      variant="glass"
      disabled={draft === null}
      aria-label={
        draft === null ? gt("Selection is too long to bookmark") : gt("Bookmark selection")
      }
      onClick={() => {
        if (draft === null) return;
        window.getSelection()?.removeAllRanges();
        onDone();
        void actions.add(draft);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onDone();
        }
      }}
    >
      <BookmarkIcon aria-hidden="true" className="size-3.5" />
      {gt("Bookmark")}
    </Button>
  );
}
