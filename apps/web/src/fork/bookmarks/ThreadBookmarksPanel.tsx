import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";

import { ThreadDetailsSection } from "../../components/chat/ThreadDetailsSection";
import { readEnvironmentScope } from "../../state/session";
import { ThreadBookmarkList } from "./ThreadBookmarkList";
import { useBookmarkSources, useThreadBookmarks } from "./threadBookmarkState";

/** The thread card's bookmark list, present only while the thread has bookmarks. */
export function ThreadBookmarksPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const bookmarks = useThreadBookmarks(threadRef);
  const sources = useBookmarkSources(threadRef);
  if (bookmarks.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-bookmarks-heading"
      title={gt("Bookmarks ({count})", { count: bookmarks.length })}
      data-thread-bookmarks-panel
    >
      <div className="max-h-[13.5rem] overflow-y-auto">
        <ThreadBookmarkList
          threadRef={threadRef}
          bookmarks={bookmarks}
          sources={sources}
          canEdit={readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)}
        />
      </div>
    </ThreadDetailsSection>
  );
}
