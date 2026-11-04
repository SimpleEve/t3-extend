// fork: the worktree subgroup header in T3 Extend's project view.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  hasMainCheckoutBadge,
  type ProjectViewWorktree,
} from "@t3tools/client-runtime/state/thread-grouping";
import { ChevronDownIcon, FolderGit2Icon, GitBranchIcon } from "lucide-react";

import { toggleSidebarGroupCollapsed } from "~/fork/sidebarViewStore";
import { useT } from "~/hooks/useT";
import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

/** The subgroup's sidebar tree row; its thread rows name it as their parent. */
export function sidebarWorktreeRowId(worktreeKey: string) {
  return `worktree:${worktreeKey}`;
}

/**
 * One checkout of a project: the main checkout first, then linked worktrees, named by
 * branch, else folder, else "Main checkout"; a main checkout named by branch also gets a Main
 * badge, so it reads apart from a worktree on the same branch. Count and dot cover every thread, folded or not.
 * Its rows are `nested` (SidebarThreadRow); the guide line sits at the icon's centre, ps-7 + 7px.
 */
export function SidebarWorktreeGroupHeader(props: {
  readonly worktree: ProjectViewWorktree<EnvironmentThreadShell>;
  readonly group: SidebarProjectSnapshot;
  readonly folderRowId: string;
}) {
  const { worktree, group } = props;
  const t = useT();
  const rowId = sidebarWorktreeRowId(worktree.key);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = resolveSidebarFolderDot(
    worktree.threads.map((thread) => ({
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        localLastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      ),
    })),
  );
  const isMain = worktree.kind === "main";
  const label = worktree.label ?? t("Main checkout");
  // Only a folder that spans machines needs to say which one a checkout is on.
  const spansEnvironments =
    new Set(group.memberProjects.map((member) => member.environmentId)).size > 1;
  const environmentLabel = spansEnvironments
    ? (group.memberProjects.find((member) => member.environmentId === worktree.environmentId)
        ?.environmentLabel ?? null)
    : null;
  const Icon = isMain ? GitBranchIcon : FolderGit2Icon;
  const buttonProps = {
    type: "button",
    "data-sidebar-row": rowId,
    "data-sidebar-parent": props.folderRowId,
    "aria-expanded": !worktree.collapsed,
    onClick: () => toggleSidebarGroupCollapsed(worktree.collapseKey),
    // One level under the project row: the icon starts at ps-7, the label at 48px like the rows below.
    className:
      "flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-(--control-radius) ps-7 pe-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  } as const;
  const content = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {hasMainCheckoutBadge(worktree) ? (
        <span className="shrink-0 rounded-sm border border-sidebar-border px-1 text-2xs leading-4">
          {t("Main", undefined, "worktree badge")}
        </span>
      ) : null}
      {environmentLabel ? (
        <span className="min-w-0 shrink truncate text-sidebar-muted-foreground/70">
          {environmentLabel}
        </span>
      ) : null}
      <span className="flex-1" />
      {dot ? (
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS_NAME[dot])}>
          <span className="sr-only">{t(DOT_LABEL[dot])}</span>
        </span>
      ) : null}
      <span className="shrink-0 tabular-nums">
        <span aria-hidden>{worktree.threads.length}</span>
        <span className="sr-only">
          {worktree.threads.length === 1
            ? t("1 thread")
            : t("{count} threads", { count: worktree.threads.length })}
        </span>
      </span>
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", worktree.collapsed && "-rotate-90")}
      />
    </>
  );
  return (
    <li
      data-testid="sidebar-worktree-group"
      className={cn(
        "relative list-none",
        // fork: guide line from under the icon through the rows below (see SidebarThreadRow).
        worktree.visibleThreads.length > 0 &&
          "after:pointer-events-none after:absolute after:-bottom-px after:left-[35px] after:top-[23px] after:z-10 after:w-px after:bg-sidebar-border",
      )}
    >
      {worktree.worktreePath === null ? (
        <button {...buttonProps}>{content}</button>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<button {...buttonProps} />}>{content}</TooltipTrigger>
          <TooltipPopup side="right">{worktree.worktreePath}</TooltipPopup>
        </Tooltip>
      )}
    </li>
  );
}
