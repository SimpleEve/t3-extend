import { createFileRoute } from "@tanstack/react-router";

import { PromptShortcutsSettings } from "../fork/promptShortcuts/PromptShortcutsSettings";

export const Route = createFileRoute("/_chat/settings/prompt-shortcuts")({
  component: PromptShortcutsSettings,
});
