import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ZapIcon } from "lucide-react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../../components/CommandPalette.logic";
import { serverEnvironment } from "../../state/server";
import { openPromptShortcutEditor } from "./promptShortcutEditorStore";

/** "New prompt shortcut", for the environment the open thread (or the primary one) belongs to. */
export function usePromptShortcutPaletteItems(
  environmentId: EnvironmentId | null,
): CommandPaletteActionItem[] {
  const gt = useGT();
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  if (environmentId === null || !canWrite) return [];
  return [
    {
      kind: "action",
      value: "action:prompt-shortcut:new",
      title: gt("New prompt shortcut"),
      searchTerms: [
        "prompt shortcut",
        "snippet",
        "template",
        "saved prompt",
        "提示词",
        "快捷方式",
        "新建提示词快捷方式",
      ],
      icon: <ZapIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openPromptShortcutEditor({ environmentId, shortcut: null });
      },
    },
  ];
}
