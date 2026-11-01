// fork: T3 Extend's sidebar views. Pure grouping shared by web and, later, Android.
import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
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
