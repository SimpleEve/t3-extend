// fork: picks between the Inbox (status) view and T3 Extend's project view.
import { isSidebarViewMode } from "@t3tools/client-runtime/state/thread-grouping";
import { FolderTreeIcon, ListIcon } from "lucide-react";

import { setSidebarViewMode, useSidebarViewMode } from "~/fork/sidebarViewStore";
import { useT } from "~/hooks/useT";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export function SidebarViewToggle() {
  const t = useT();
  const mode = useSidebarViewMode();
  const label = mode === "project" ? t("Sidebar view: by project") : t("Sidebar view: by status");
  return (
    <Menu>
      <MenuTrigger render={<SidebarHeaderIconButton label={label} />}>
        {mode === "project" ? (
          <FolderTreeIcon className="size-4" />
        ) : (
          <ListIcon className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>{t("Group threads")}</MenuGroupLabel>
          <MenuRadioGroup
            value={mode}
            onValueChange={(value) => {
              if (isSidebarViewMode(value)) void setSidebarViewMode(value);
            }}
          >
            <MenuRadioItem value="status" closeOnClick>
              {t("By status")}
            </MenuRadioItem>
            <MenuRadioItem value="project" closeOnClick>
              {t("By project")}
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
