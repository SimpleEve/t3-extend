import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useT } from "../../../hooks/useT"; // fork: i18n

/** What the compose button starts on the selected tab; null where the tab has nothing to start. */
export function useWorkspaceCompose() {
  const t = useT(); // fork: i18n
  const workspace = useWorkspaceTabs();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  if (!workspace || workspace.settingsOpen || workspace.state.selectedTab !== "threads")
    return null;
  return { label: t("New chat"), onPress: startNewTask } as const; // fork: i18n
}
