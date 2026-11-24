import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadBookmark,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { create } from "zustand";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
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
import {
  useBookmarkSources,
  useThreadBookmarks,
  useThreadBookmarksLoaded,
} from "./threadBookmarkState";
import { useThreadBookmarkActions } from "./useThreadBookmarkActions";

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
  const loaded = useThreadBookmarksLoaded(threadRef);
  const bookmarks = useThreadBookmarks(threadRef);
  const sources = useBookmarkSources(threadRef);
  const actions = useThreadBookmarkActions(threadRef);
  // The dialog covers the toast a removal raises and takes its clicks, so Undo lives here.
  const [removed, setRemoved] = useState<ThreadBookmark | null>(null);
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
          {!loaded ? (
            <div className="flex justify-center py-6">
              <Spinner size="md" tone="muted" />
            </div>
          ) : bookmarks.length === 0 ? (
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
              onRemoved={setRemoved}
            />
          )}
          {removed === null ? null : (
            <div
              role="status"
              className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-accent/50 px-2.5 py-1.5 text-xs"
            >
              <span>{gt("Bookmark removed")}</span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  void actions.restore(removed).then((restored) => {
                    if (restored) setRemoved(null);
                  });
                }}
              >
                {gt("Undo")}
              </Button>
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
