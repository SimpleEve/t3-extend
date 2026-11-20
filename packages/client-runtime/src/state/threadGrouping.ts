// fork: T3 Extend's sidebar views. Pure grouping shared by web and, later, Android.
import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { THREAD_STATUS_TEXT } from "./threadActivityAnnouncement.ts";
import { hasUnseenRunFailure } from "./threadSettled.ts";
import { sortWorkingThreadsBySend } from "./threadInbox.ts";

/** "status" is the upstream Inbox; "project" folds active threads by project, then worktree. */
export type SidebarViewMode = "status" | "project";

export function isSidebarViewMode(value: unknown): value is SidebarViewMode {
  return value === "status" || value === "project";
}

const MAIN_CHECKOUT_KEY = "<main>";

type WorktreeThreadInput = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "worktreePath"
  | "branch"
  | "createdAt"
  | "latestRun"
  | "latestUserAuthoredMessageAt"
>;

export interface ThreadWorktreeGroup<T> {
  /** `${environmentId}:${projectId}:${worktreePath ?? "<main>"}`, so machines never merge. */
  readonly key: string;
  readonly kind: "main" | "linked";
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly worktreePath: string | null;
  /** The newest thread's branch, else a linked worktree's folder name; null for a main checkout with neither. */
  readonly label: string | null;
  /** Newest send first, like the boring sidebar's folders. */
  readonly threads: readonly T[];
}

/** A main checkout named by its branch needs a badge; without one it is already called "Main checkout". */
export function hasMainCheckoutBadge(group: Pick<ThreadWorktreeGroup<unknown>, "kind" | "label">) {
  return group.kind === "main" && group.label !== null;
}

function normalizedWorktreePath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  return trimmed ? trimmed : null;
}

export function threadWorktreeGroupKey(
  thread: Pick<WorktreeThreadInput, "environmentId" | "projectId" | "worktreePath">,
): string {
  const path = normalizedWorktreePath(thread.worktreePath);
  return `${thread.environmentId}:${thread.projectId}:${path ?? MAIN_CHECKOUT_KEY}`;
}

function worktreeFolderName(path: string): string {
  const parts = path.split(/[\\/]+/u).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * Splits one project's threads by checkout. Main checkouts come first, then linked
 * worktrees by their newest user send, so agent activity alone never reorders them.
 * Returns null when every thread is in a main checkout: there is nothing to split.
 */
export function groupThreadsByWorktree<T extends WorktreeThreadInput>(
  threads: readonly T[],
): ThreadWorktreeGroup<T>[] | null {
  if (threads.every((thread) => normalizedWorktreePath(thread.worktreePath) === null)) {
    return null;
  }
  const byKey = new Map<string, { first: T; threads: T[] }>();
  for (const thread of sortWorkingThreadsBySend(threads)) {
    const key = threadWorktreeGroupKey(thread);
    const entry = byKey.get(key);
    if (entry) entry.threads.push(thread);
    else byKey.set(key, { first: thread, threads: [thread] });
  }
  const groups = [...byKey].map(([key, { first, threads: groupThreads }]) => {
    const worktreePath = normalizedWorktreePath(first.worktreePath);
    const branch = first.branch?.trim() || null;
    return {
      key,
      kind: worktreePath === null ? ("main" as const) : ("linked" as const),
      environmentId: first.environmentId,
      projectId: first.projectId,
      worktreePath,
      label: branch ?? (worktreePath === null ? null : worktreeFolderName(worktreePath)),
      threads: groupThreads,
    };
  });
  // Stable sort: within each kind, groups keep newest-send order.
  return [...groups].sort(
    (left, right) => Number(left.kind === "linked") - Number(right.kind === "linked"),
  );
}

/** Persisted fold keys. The mode prefix keeps one view's folds off another view's groups. */
export function sidebarGroupCollapseKey(
  mode: SidebarViewMode,
  group:
    | { readonly kind: "project"; readonly projectKey: string }
    | { readonly kind: "worktree"; readonly key: string },
): string {
  return group.kind === "project"
    ? `${mode}:project:${group.projectKey}`
    : `${mode}:worktree:${group.key}`;
}

export interface ProjectViewWorktree<T> extends ThreadWorktreeGroup<T> {
  readonly collapseKey: string;
  readonly collapsed: boolean;
  /** Rows drawn under the header: all of them, or only the open thread while folded. */
  readonly visibleThreads: readonly T[];
  /** Threads a folded header stands for, for its count and dot. */
  readonly hiddenThreads: readonly T[];
}

export interface ProjectViewFolder<G, T> {
  readonly group: G;
  readonly collapseKey: string;
  readonly collapsed: boolean;
  /** Every row the folder draws, in screen order; keyboard jumps walk this. */
  readonly threads: readonly T[];
  readonly hiddenThreads: readonly T[];
  /** Null when the folder is folded or has no linked worktree; then rows sit right under the folder. */
  readonly worktrees: readonly ProjectViewWorktree<T>[] | null;
}

/**
 * Lays out project-view folders from the boring sidebar's project folders, whose threads
 * arrive newest send first. Only those active threads are placed; pinned, snoozed, and
 * settled stay in their shelves.
 * A folded folder or worktree still shows the open thread, like boring folders do.
 */
export function buildProjectViewFolders<
  G extends { readonly projectKey: string },
  T extends WorktreeThreadInput,
>(input: {
  readonly folders: ReadonlyArray<{ readonly group: G; readonly threads: readonly T[] }>;
  readonly isCollapsed: (collapseKey: string) => boolean;
  readonly openThreadKey: string | null;
  readonly threadKey: (thread: T) => string;
}): ProjectViewFolder<G, T>[] {
  const { isCollapsed, openThreadKey, threadKey } = input;
  const fold = (threads: readonly T[], collapsed: boolean) => {
    if (!collapsed) return { visible: threads, hidden: [] as T[] };
    const open = threads.filter((thread) => threadKey(thread) === openThreadKey);
    return {
      visible: open,
      hidden: threads.filter((thread) => threadKey(thread) !== openThreadKey),
    };
  };
  return input.folders.map(({ group, threads }) => {
    const collapseKey = sidebarGroupCollapseKey("project", {
      kind: "project",
      projectKey: group.projectKey,
    });
    const collapsed = isCollapsed(collapseKey);
    const worktreeGroups = collapsed ? null : groupThreadsByWorktree(threads);
    if (worktreeGroups === null) {
      const { visible, hidden } = fold(threads, collapsed);
      return {
        group,
        collapseKey,
        collapsed,
        threads: visible,
        hiddenThreads: hidden,
        worktrees: null,
      };
    }
    const worktrees = worktreeGroups.map((worktree) => {
      const worktreeKey = sidebarGroupCollapseKey("project", {
        kind: "worktree",
        key: worktree.key,
      });
      const worktreeCollapsed = isCollapsed(worktreeKey);
      const { visible, hidden } = fold(worktree.threads, worktreeCollapsed);
      return {
        ...worktree,
        collapseKey: worktreeKey,
        collapsed: worktreeCollapsed,
        visibleThreads: visible,
        hiddenThreads: hidden,
      };
    });
    return {
      group,
      collapseKey,
      collapsed,
      threads: worktrees.flatMap((worktree) => worktree.visibleThreads),
      hiddenThreads: [],
      worktrees,
    };
  });
}

/**
 * Puts each thread in the folder of the project group that owns it, in group order.
 * Threads of a project no group knows are dropped; empty folders stay when `keepEmpty` says so.
 */
export function groupThreadsByProject<
  TGroup extends {
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectId: string;
    }>;
  },
  TThread extends { readonly environmentId: EnvironmentId; readonly projectId: string },
>(
  groups: readonly TGroup[],
  threads: readonly TThread[],
  keepEmpty: (group: TGroup) => boolean,
): Array<{ group: TGroup; threads: TThread[] }> {
  const folders = groups.map((group) => ({ group, threads: [] as TThread[] }));
  const folderByProject = new Map<string, (typeof folders)[number]>();
  for (const folder of folders) {
    for (const ref of folder.group.memberProjectRefs) {
      folderByProject.set(`${ref.environmentId}:${ref.projectId}`, folder);
    }
  }
  for (const thread of threads) {
    folderByProject.get(`${thread.environmentId}:${thread.projectId}`)?.threads.push(thread);
  }
  return folders.filter((folder) => folder.threads.length > 0 || keepEmpty(folder.group));
}

/** Every thread a folder stands for, folded or not; a header's count. */
export function projectViewFolderThreadCount<G, T>(folder: ProjectViewFolder<G, T>): number {
  if (folder.worktrees !== null) {
    return folder.worktrees.reduce((total, worktree) => total + worktree.threads.length, 0);
  }
  return folder.threads.length + folder.hiddenThreads.length;
}

/** One line of the project view for a flat, virtualized list. */
export type ProjectViewRow<G, T> =
  | {
      readonly kind: "project";
      readonly collapseKey: string;
      readonly group: G;
      readonly collapsed: boolean;
      readonly count: number;
      /** Threads a folded project does not draw, for its dot. */
      readonly hiddenThreads: readonly T[];
    }
  | {
      readonly kind: "worktree";
      readonly collapseKey: string;
      readonly group: G;
      readonly worktree: ProjectViewWorktree<T>;
      readonly collapsed: boolean;
      readonly count: number;
    }
  | { readonly kind: "thread"; readonly thread: T };

/**
 * Lays folders out top to bottom: the project header, then each worktree header with its
 * rows, or the folder's rows when it has no worktree split.
 */
export function flattenProjectViewFolders<G, T>(
  folders: ReadonlyArray<ProjectViewFolder<G, T>>,
): ProjectViewRow<G, T>[] {
  const rows: ProjectViewRow<G, T>[] = [];
  for (const folder of folders) {
    rows.push({
      kind: "project",
      collapseKey: folder.collapseKey,
      group: folder.group,
      collapsed: folder.collapsed,
      count: projectViewFolderThreadCount(folder),
      hiddenThreads: folder.hiddenThreads,
    });
    if (folder.worktrees === null) {
      for (const thread of folder.threads) rows.push({ kind: "thread", thread });
      continue;
    }
    for (const worktree of folder.worktrees) {
      rows.push({
        kind: "worktree",
        collapseKey: worktree.collapseKey,
        group: folder.group,
        worktree,
        collapsed: worktree.collapsed,
        count: worktree.threads.length,
      });
      for (const thread of worktree.visibleThreads) rows.push({ kind: "thread", thread });
    }
  }
  return rows;
}

export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "request"
  | "preparing"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

type SidebarThreadStatusInput = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
>;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (thread.runtime?.status === "preparing") {
    return "preparing";
  }
  if (
    thread.runtime !== null &&
    ["queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

type UnseenCompletionInput = Pick<EnvironmentThreadShell, "latestRun"> & {
  readonly lastVisitedAt?: string | null | undefined;
};

export function hasUnseenCompletion(thread: UnseenCompletionInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  // Upstream 40dcbc5f6a: a stopped run is not a finished one the user has yet to see.
  if (thread.latestRun.status === "interrupted" || thread.latestRun.status === "cancelled") {
    return false;
  }
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Sidebar row status: a failure the user has already opened settles to ready, like Done. */
export function resolveSidebarRowStatus(
  thread: UnseenCompletionInput & SidebarThreadStatusInput,
): SidebarThreadStatus {
  const status = resolveSidebarThreadStatus(thread);
  // A runtime failure without a failed run has nothing to date it, so it stays.
  if (status !== "failed" || thread.latestRun?.status !== "failed") return status;
  return hasUnseenRunFailure(thread) ? status : "ready";
}

/** What the window title says the open thread is doing, in the words its announcer uses. */
export function resolveWindowTitleThreadStatus(
  thread: SidebarThreadStatusInput,
  resolve: MFunctionType = mFallback,
): string | null {
  // A guest waiting doesn't hide that the agent is still working.
  switch (resolveSidebarThreadStatus({ ...thread, pendingGuestMessageCount: 0 })) {
    case "approval":
      return resolve(THREAD_STATUS_TEXT.approval);
    case "input":
      return resolve(THREAD_STATUS_TEXT.input);
    case "preparing":
    case "working":
      return resolve(THREAD_STATUS_TEXT.working);
    case "waiting":
      // Waiting on a child thread is still this turn, so it must not read as finished.
      return thread.runtime?.status === "running" ? resolve(THREAD_STATUS_TEXT.working) : null;
    default:
      return null;
  }
}

export type SidebarFolderDot = "attention" | "failed" | "unread" | "working";

/**
 * The dot on a closed folder or worktree header: the most urgent state among its
 * threads. Waiting threads stay quiet, like their rows.
 */
export function resolveSidebarFolderDot(
  threads: ReadonlyArray<UnseenCompletionInput & SidebarThreadStatusInput>,
): SidebarFolderDot | null {
  const statuses = new Set(threads.map(resolveSidebarRowStatus));
  if (
    statuses.has("input") ||
    statuses.has("approval") ||
    statuses.has("request") ||
    statuses.has("limited")
  ) {
    return "attention";
  }
  if (statuses.has("failed")) return "failed";
  // Rows show Done only for ready threads, so the dot follows the same rule.
  const hasUnread = threads.some(
    (thread) => resolveSidebarRowStatus(thread) === "ready" && hasUnseenCompletion(thread),
  );
  if (hasUnread) return "unread";
  if (statuses.has("working") || statuses.has("preparing")) return "working";
  return null;
}
