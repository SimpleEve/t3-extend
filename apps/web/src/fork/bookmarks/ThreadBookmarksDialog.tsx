import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { create } from "zustand";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { readEnvironmentScope } from "../../state/session";
import { ThreadBookmarkList } from "./ThreadBookmarkList";
import { useBookmarkSources, useThreadBookmarks } from "./threadBookmarkState";

const useBookmarksDialog = create<{ threadRef: ScopedThreadRef | null }>(() => ({
  threadRef: null,
}));

export function openThreadBookmarksDialog(threadRef: ScopedThreadRef) {
  useBookmarksDialog.setState({ threadRef });
}

const closeDialog = () => useBookmarksDialog.setState({ threadRef: null });

export function ThreadBookmarksDialogHost() {
  const threadRef = useBookmarksDialog((state) => state.threadRef);
  return threadRef ? <ThreadBookmarksDialog threadRef={threadRef} /> : null;
}

function ThreadBookmarksDialog({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const bookmarks = useThreadBookmarks(threadRef);
  const sources = useBookmarkSources(threadRef);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>Bookmarks</T>
          </DialogTitle>
          <DialogDescription>
            <T>Click one to open it in the conversation.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {bookmarks.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {gt("No bookmarks in this thread")}
            </p>
          ) : (
            <ThreadBookmarkList
              threadRef={threadRef}
              bookmarks={bookmarks}
              sources={sources}
              canEdit={readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)}
              onRevealed={closeDialog}
            />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
