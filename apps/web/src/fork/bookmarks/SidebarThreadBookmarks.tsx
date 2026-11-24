import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { THREAD_BOOKMARK_PREVIEW_COUNT } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BookmarkIcon } from "lucide-react";

import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "../../components/ui/preview-card";
import { openThreadBookmarksDialog } from "./ThreadBookmarksDialog";

/** Shown on a thread row that has bookmarks: hover lists the first few, a click opens them all. */
export function SidebarThreadBookmarks({ thread }: { thread: EnvironmentThreadShell }) {
  const gt = useGT();
  const count = thread.source.bookmarkCount ?? 0;
  if (count === 0) return null;
  const previews = thread.source.bookmarkPreviews ?? [];
  const hidden = count - Math.min(previews.length, THREAD_BOOKMARK_PREVIEW_COUNT);
  return (
    <PreviewCard>
      <PreviewCardTrigger
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={gt("Bookmarks ({count})", { count })}
            className="inline-flex shrink-0 cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
      </PreviewCardTrigger>
      <PreviewCardPopup side="right" align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-2">
          {previews.slice(0, THREAD_BOOKMARK_PREVIEW_COUNT).map((preview) => (
            <li key={preview.id} className="flex min-w-0 items-center gap-1.5 text-xs">
              <BookmarkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{preview.label}</span>
            </li>
          ))}
          {hidden > 0 ? (
            <li className="ps-4.5 text-xs text-muted-foreground">
              {gt("{count} more", { count: hidden })}
            </li>
          ) : null}
        </ul>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
