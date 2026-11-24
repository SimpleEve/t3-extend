import type { ScopedThreadRef } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useMessageBookmarkKind } from "./threadBookmarkState";

const RIBBON =
  "absolute h-3.5 w-[3px] bg-muted-foreground/80 [clip-path:polygon(0_0,100%_0,100%_100%,50%_75%,0_100%)]";

/**
 * A small ribbon beside a message that carries a bookmark, the same for both authors. The timeline
 * lane clips what sits outside it, so an assistant's ribbon sits in the lane's free 4px beside the
 * text (`lane`), and a user's sits just left of its right-aligned bubble (`bubble`, mounted inside
 * the bubble, which is where its left edge is known).
 */
export function BookmarkMessageMarker({
  threadRef,
  messageId,
  role,
  placement = "lane",
}: {
  threadRef: ScopedThreadRef | null;
  messageId: string;
  role: "user" | "assistant" | "system";
  placement?: "lane" | "bubble";
}) {
  const kind = useMessageBookmarkKind(threadRef, messageId);
  if (kind === "none") return null;
  if ((role === "user") !== (placement === "bubble")) return null;
  if (placement === "bubble") {
    return (
      <span
        aria-hidden
        data-bookmark-marker={kind}
        className={cn(RIBBON, "end-full top-3 me-1.5")}
      />
    );
  }
  return (
    <span className="relative block h-0 w-0" data-bookmark-marker={kind}>
      <span aria-hidden className={cn(RIBBON, "start-0 top-2")} />
    </span>
  );
}
