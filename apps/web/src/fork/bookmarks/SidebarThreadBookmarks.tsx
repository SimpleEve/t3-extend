import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { THREAD_BOOKMARK_PREVIEW_COUNT } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BookmarkIcon } from "lucide-react";

import { ThreadHoverCard, ThreadHoverCardPopup } from "../../components/ThreadHoverCard";
import { Tooltip, TooltipTrigger } from "../../components/ui/tooltip";
import { openThreadBookmarksDialog } from "./ThreadBookmarksDialog";

/**
 * Shown on a thread row that has bookmarks: hover lists the first few, a click opens them all. It
 * is a Tooltip like the row's own hover card and the pin, so the tooltip group closes the row's
 * card while this one is open and the two never stack.
 */
export function SidebarThreadBookmarks({ thread }: { thread: EnvironmentThreadShell }) {
  const gt = useGT();
  const count = thread.source.bookmarkCount ?? 0;
  if (count === 0) return null;
  const previews = thread.source.bookmarkPreviews ?? [];
  const hidden = count - Math.min(previews.length, THREAD_BOOKMARK_PREVIEW_COUNT);
  const title = gt("Bookmarks ({count})", { count });
  return (
    <Tooltip>
      <TooltipTrigger
        delay={250}
        render={
          <button
            type="button"
            aria-label={title}
            className="inline-flex shrink-0 cursor-pointer items-center rounded-sm text-sidebar-muted-foreground/75 outline-none transition-colors hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openThreadBookmarksDialog({
                environmentId: thread.environmentId,
                threadId: thread.id,
              });
            }}
          />
        }
      >
        <BookmarkIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
        <ThreadHoverCard title={title}>
          {previews.slice(0, THREAD_BOOKMARK_PREVIEW_COUNT).map((preview) => (
            <div key={preview.id} className="flex min-w-0 items-center gap-1.5">
              <BookmarkIcon aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{preview.label}</span>
            </div>
          ))}
          {hidden > 0 ? (
            <div className="ps-4.5">{gt("{count} more", { count: hidden })}</div>
          ) : null}
        </ThreadHoverCard>
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}
