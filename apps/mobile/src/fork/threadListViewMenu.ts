// fork: the "Group threads" entry of the thread list's filter menu.
import type { Translator } from "@t3tools/client-runtime/i18n";
import {
  isSidebarViewMode,
  type SidebarViewMode,
} from "@t3tools/client-runtime/state/thread-grouping";
import type { MenuAction } from "@react-native-menu/menu";

const VIEW_EVENT_PREFIX = "view:";

export function threadListViewMenuAction(viewMode: SidebarViewMode, t: Translator): MenuAction {
  return {
    id: "view",
    title: t("Group threads"),
    subactions: [
      {
        id: `${VIEW_EVENT_PREFIX}status`,
        title: t("By status"),
        state: viewMode === "status" ? "on" : "off",
      },
      {
        id: `${VIEW_EVENT_PREFIX}project`,
        title: t("By project"),
        state: viewMode === "project" ? "on" : "off",
      },
    ],
  };
}

/** The view a menu event picks, or null when the event is another entry's. */
export function threadListViewFromMenuEvent(event: string): SidebarViewMode | null {
  if (!event.startsWith(VIEW_EVENT_PREFIX)) return null;
  const mode = event.slice(VIEW_EVENT_PREFIX.length);
  return isSidebarViewMode(mode) ? mode : null;
}
