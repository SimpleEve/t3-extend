import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildProjectViewFolders,
  sidebarGroupCollapseKey,
  type ProjectViewWorktree,
} from "@t3tools/client-runtime/state/thread-grouping";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { groupSidebarThreadsByProject } from "../components/Sidebar.logic";
import {
  toggleSidebarGroupCollapsed,
  useSidebarViewMode,
  useSidebarViewStore,
} from "./sidebarViewStore";

/**
 * A folder as the sidebar list draws it. Boring folders omit `worktrees`; the project
 * view sets it, or null when the folder is folded or has only main-checkout threads.
 */
export interface SidebarFolderView {
  readonly group: SidebarProjectSnapshot;
  readonly collapsed: boolean;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly hiddenThreads: readonly EnvironmentThreadShell[];
  readonly worktrees?: readonly ProjectViewWorktree<EnvironmentThreadShell>[] | null;
}

const threadKey = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

function toggleProjectViewFolder(group: SidebarProjectSnapshot) {
  toggleSidebarGroupCollapsed(
    sidebarGroupCollapseKey("project", { kind: "project", projectKey: group.projectKey }),
  );
}

/**
 * The project view's folders, or null in the status view. `folderGroups` is the same
 * project order boring folders use, so both views agree on which projects get a folder.
 */
export function useProjectViewFolders(input: {
  readonly folderGroups: readonly SidebarProjectSnapshot[] | null;
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly keepEmpty: (group: SidebarProjectSnapshot) => boolean;
  readonly routeRowThreadKey: string | null;
}): {
  readonly folders: SidebarFolderView[];
  readonly toggleFolder: (group: SidebarProjectSnapshot) => void;
} | null {
  const mode = useSidebarViewMode();
  const collapsed = useSidebarViewStore((state) => state.collapsed);
  if (mode !== "project" || input.folderGroups === null) return null;
  const collapsedKeys = new Set(collapsed);
  const folders = buildProjectViewFolders({
    folders: groupSidebarThreadsByProject(input.folderGroups, input.activeThreads, input.keepEmpty),
    isCollapsed: (key) => collapsedKeys.has(key),
    openThreadKey: input.routeRowThreadKey,
    threadKey,
  });
  return { folders, toggleFolder: toggleProjectViewFolder };
}
