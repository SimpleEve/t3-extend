import type { MessageId, OrchestrationV2AppThread } from "@t3tools/contracts";
import { DateTime, Effect } from "effect";

import { forkInheritedRunOrdinals, type ProjectionStoreV2Shape } from "./ProjectionStore.ts";

// fork: message bookmarks. A run fork shows its source's history above its own messages, and
// those rows keep the source's message ids, so a bookmark on one has to find its message there.

type MessageLookupStore = Pick<
  ProjectionStoreV2Shape,
  "getMessagesById" | "findThread" | "getThreadRecords"
>;

/**
 * When the thread can show this message, as an ISO time: its own message, or one it inherits
 * through its fork chain from before each fork point. Null when the thread does not show it.
 */
export const findBookmarkableMessageCreatedAt = Effect.fn(
  "ThreadBookmarks.findBookmarkableMessageCreatedAt",
)(function* (
  store: MessageLookupStore,
  thread: Pick<OrchestrationV2AppThread, "id" | "forkedFrom" | "lineage" | "createdAt">,
  messageId: MessageId,
) {
  const own = (yield* store.getMessagesById(thread.id, [messageId])).get(messageId);
  if (own !== undefined) return DateTime.formatIso(own.createdAt);

  let child = thread;
  for (;;) {
    // Side chats show only their own rows, so they inherit nothing.
    if (child.forkedFrom?.type !== "run" || child.lineage.sideChat === true) return null;
    const fork = child.forkedFrom;
    const parent = yield* store.findThread(fork.threadId);
    if (parent === null) return null;
    const message = (yield* store.getMessagesById(parent.id, [messageId])).get(messageId);
    if (message === undefined) {
      child = parent;
      continue;
    }
    const { runs } = yield* store.getThreadRecords(parent.id, ["runs"]);
    const cutoff = runs.find((run) => run.id === fork.runId)?.ordinal;
    const ordinal =
      message.runId === null
        ? undefined
        : forkInheritedRunOrdinals(runs, child.createdAt).get(message.runId);
    const shown =
      cutoff !== undefined &&
      (message.runId === null
        ? parent.historyOrigin === "v1_import"
        : ordinal !== undefined && ordinal <= cutoff);
    return shown ? DateTime.formatIso(message.createdAt) : null;
  }
});
