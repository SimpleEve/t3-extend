import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  wholeMessageBookmark,
  type ThreadBookmarkDraft,
} from "@t3tools/client-runtime/state/thread-bookmarks";
import { ThreadBookmarkId, type ScopedThreadRef, type ThreadBookmark } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { randomUUID } from "../../lib/utils";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";

/** Bookmark changes for one thread. Failures surface as a toast; each call says whether it went through. */
export function useThreadBookmarkActions(threadRef: ScopedThreadRef) {
  const gt = useGT();
  const m = useMessages();
  const addBookmark = useOrchestrationCommand(threadEnvironment.addBookmark, {
    reportFailure: false,
  });
  const updateBookmark = useOrchestrationCommand(threadEnvironment.updateBookmark, {
    reportFailure: false,
  });
  const removeBookmark = useOrchestrationCommand(threadEnvironment.removeBookmark, {
    reportFailure: false,
  });
  const { environmentId, threadId } = threadRef;

  const reportFailure = (title: string, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? String(error),
      }),
    );

  const add = async (
    draft: ThreadBookmarkDraft,
    extra: Pick<ThreadBookmark, "id" | "title" | "note" | "createdAt"> | null = null,
  ): Promise<boolean> => {
    const result = await addBookmark({
      environmentId,
      input: {
        threadId,
        bookmark: {
          ...draft,
          bookmarkId: extra?.id ?? ThreadBookmarkId.make(randomUUID()),
          ...(extra === null
            ? {}
            : { title: extra.title, note: extra.note, createdAt: extra.createdAt }),
        },
      },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not add the bookmark"), squashAtomCommandFailure(result));
    }
    return false;
  };

  const update = async (
    bookmark: Pick<ThreadBookmark, "id">,
    changes: { readonly title: string | null; readonly note: string | null },
  ): Promise<boolean> => {
    const result = await updateBookmark({
      environmentId,
      input: { threadId, bookmarkId: bookmark.id, ...changes },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not save the bookmark"), squashAtomCommandFailure(result));
    }
    return false;
  };

  /** Removing never asks: the toast offers Undo, which adds the same bookmark back. */
  const remove = async (bookmark: ThreadBookmark): Promise<boolean> => {
    const result = await removeBookmark({
      environmentId,
      input: { threadId, bookmarkId: bookmark.id },
    });
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(gt("Could not remove the bookmark"), squashAtomCommandFailure(result));
      }
      return false;
    }
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "info",
        title: gt("Bookmark removed"),
        timeout: 6000,
        actionProps: {
          children: gt("Undo"),
          onClick: () => {
            toastManager.close(toastId);
            void add(
              {
                messageId: bookmark.messageId,
                kind: bookmark.kind,
                excerpt: bookmark.excerpt,
                ...(bookmark.selectionStart === undefined
                  ? {}
                  : { selectionStart: bookmark.selectionStart }),
                ...(bookmark.selectionEnd === undefined
                  ? {}
                  : { selectionEnd: bookmark.selectionEnd }),
                ...(bookmark.selectionPrefix === undefined
                  ? {}
                  : { selectionPrefix: bookmark.selectionPrefix }),
                ...(bookmark.selectionSuffix === undefined
                  ? {}
                  : { selectionSuffix: bookmark.selectionSuffix }),
              },
              bookmark,
            );
          },
        },
      }),
    );
    return true;
  };

  /** The bookmark button on a message: bookmarks the whole message, or removes that bookmark. */
  const toggleMessage = async (
    bookmarks: ReadonlyArray<ThreadBookmark>,
    messageId: string,
    draft: () => ThreadBookmarkDraft | null,
  ): Promise<void> => {
    const held = wholeMessageBookmark(bookmarks, messageId);
    if (held) {
      await remove(held);
      return;
    }
    const next = draft();
    if (next !== null) await add(next);
  };

  return { add, update, remove, toggleMessage };
}
