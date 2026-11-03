// fork: the "Invite a device" palette action (design Q11). Desktop only: it opens the Devices section
// of Settings, where the invite dialog or, if this computer has not joined, the join dialog opens.
import { useNavigate } from "@tanstack/react-router";
import { UserPlusIcon } from "lucide-react";

import { requestDeviceInvite } from "./deviceKeysStore";
import { useT } from "../hooks/useT";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";

export function useYourServerPaletteItems(): CommandPaletteActionItem[] {
  const t = useT();
  const navigate = useNavigate();
  if (typeof window === "undefined" || window.desktopBridge === undefined) return [];
  return [
    {
      kind: "action",
      value: "action:devices:invite",
      title: t("Invite a device"),
      searchTerms: ["invite", "device", "phone", "computer", "server", "pair", "join"],
      icon: <UserPlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/access" });
        requestDeviceInvite();
      },
    },
  ];
}
