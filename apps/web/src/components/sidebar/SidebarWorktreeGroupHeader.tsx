// fork: the worktree subgroup header in T3 Extend's project view.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectViewWorktree } from "@t3tools/client-runtime/state/thread-grouping";
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
 * Names one checkout of a project: the main checkout first, with a Main badge, then
 * linked worktrees. Its count and dot cover every thread in it, folded or not. It reads
 * no VCS status, so it adds no subscriptions.
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
    role: "treeitem",
    tabIndex: -1,
    "data-sidebar-row": rowId,
    "data-sidebar-parent": props.folderRowId,
    "aria-expanded": !worktree.collapsed,
    onClick: () => toggleSidebarGroupCollapsed(worktree.collapseKey),
    // ps-9 lines the label up with the folder name, like the folder's thread rows.
    className:
      "flex h-7 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) ps-9 pe-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  } as const;
  const content = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {isMain ? (
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
    <li data-testid="sidebar-worktree-group" className="list-none">
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
