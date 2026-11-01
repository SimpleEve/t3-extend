// fork: command palette entries for T3 Extend's sidebar views.
import { FolderTreeIcon, ListIcon } from "lucide-react";

import { setSidebarViewMode, useSidebarViewMode } from "../fork/sidebarViewStore";
import { useT } from "../hooks/useT";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

export function useCommandPaletteSidebarViewItems(): CommandPaletteActionItem[] {
  const t = useT();
  const mode = useSidebarViewMode();
  return [
    {
      kind: "action",
      value: "action:sidebar-view:status",
      title: t("Sidebar: Group by status"),
      searchTerms: ["sidebar", "group", "status", "inbox", "view"],
      icon: <ListIcon className={ITEM_ICON_CLASS} />,
      ...(mode === "status" ? { description: t("Current") } : {}),
      run: async () => setSidebarViewMode("status"),
    },
    {
      kind: "action",
      value: "action:sidebar-view:project",
      title: t("Sidebar: Group by project"),
      searchTerms: ["sidebar", "group", "project", "worktree", "branch", "view"],
      icon: <FolderTreeIcon className={ITEM_ICON_CLASS} />,
      ...(mode === "project" ? { description: t("Current") } : {}),
      run: async () => setSidebarViewMode("project"),
    },
  ];
}
