// fork: lays the active threads of the mobile list out by project, then worktree.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  buildProjectViewFolders,
  flattenProjectViewFolders,
  groupThreadsByProject,
  type ProjectViewRow,
} from "@t3tools/client-runtime/state/thread-grouping";
import { sortWorkingThreadsBySend } from "@t3tools/client-runtime/state/thread-inbox";
import type { ScopedProjectRef } from "@t3tools/contracts";

export interface ThreadListProjectGroup {
  readonly projectKey: string;
  readonly title: string;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

export type ThreadListProjectRow = ProjectViewRow<ThreadListProjectGroup, EnvironmentThreadShell>;

/** Holds the threads of projects the catalog does not list, so none vanish from the list. */
export const OTHER_PROJECTS_GROUP_KEY = "<other>";

/**
 * `items` is the status layout built without a Working shelf: pinned rows first, then the
 * active rows up to the first shelf. Only the active rows are regrouped; pinned, snoozed, and
 * settled threads keep their places, like the web sidebar's project view.
 */
export function buildThreadListProjectRows(input: {
  readonly items: ReadonlyArray<{
    readonly thread: EnvironmentThreadShell;
    readonly pinned: boolean;
  }>;
  readonly firstShelfIndex: number | null;
  readonly groups: ReadonlyArray<ThreadListProjectGroup>;
  readonly collapsedKeys: ReadonlySet<string>;
  readonly openThreadKey: string | null;
  readonly otherTitle: string;
}): { readonly activeStart: number; readonly rows: ThreadListProjectRow[] } {
  const activeStart = input.items.findIndex((item) => !item.pinned);
  const start = activeStart === -1 ? input.items.length : activeStart;
  const end = input.firstShelfIndex ?? input.items.length;
  const active = sortWorkingThreadsBySend(
    input.items.slice(start, Math.max(start, end)).map((item) => item.thread),
  );

  const known = new Set(
    input.groups.flatMap((group) =>
      group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
    ),
  );
  const orphanRefs = new Map<string, ScopedProjectRef>();
  for (const thread of active) {
    const key = `${thread.environmentId}:${thread.projectId}`;
    if (!known.has(key) && !orphanRefs.has(key)) {
      orphanRefs.set(key, { environmentId: thread.environmentId, projectId: thread.projectId });
    }
  }
  const groups =
    orphanRefs.size === 0
      ? input.groups
      : [
          ...input.groups,
          {
            projectKey: OTHER_PROJECTS_GROUP_KEY,
            title: input.otherTitle,
            memberProjectRefs: [...orphanRefs.values()],
          },
        ];

  const folders = buildProjectViewFolders({
    folders: groupThreadsByProject(groups, active, () => false),
    isCollapsed: (collapseKey) => input.collapsedKeys.has(collapseKey),
    openThreadKey: input.openThreadKey,
    threadKey: (thread) => `${thread.environmentId}:${thread.id}`,
  });
  return { activeStart: start, rows: flattenProjectViewFolders(folders) };
}
