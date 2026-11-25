import { AuthSettingsWriteScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ZapIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useEnvironmentScope } from "../../state/session";
import { openPromptShortcutEditor } from "./promptShortcutEditorStore";

/** On a message's hover bar: opens the shortcut dialog with the message's text. */
export function SaveMessageAsShortcutButton({
  threadRef,
  content,
  cwd,
}: {
  threadRef: ScopedThreadRef;
  content: string;
  cwd: string | undefined;
}) {
  const gt = useGT();
  const canWrite = useEnvironmentScope(threadRef.environmentId, AuthSettingsWriteScope);
  if (!canWrite) return null;
  const label = gt("Save as shortcut");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={() =>
              openPromptShortcutEditor({
                environmentId: threadRef.environmentId,
                shortcut: null,
                content,
                cwd,
              })
            }
          />
        }
      >
        <ZapIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Beside "Bookmark" on the selection toolbar of the user's own message: saves just the selection. */
export function SelectionShortcutButton({
  threadRef,
  text,
  onDone,
}: {
  threadRef: ScopedThreadRef;
  text: string;
  /** Called once the dialog is on its way, so the toolbar can go. */
  onDone: () => void;
}) {
  const gt = useGT();
  const canWrite = useEnvironmentScope(threadRef.environmentId, AuthSettingsWriteScope);
  if (!canWrite) return null;
  return (
    <Button
      type="button"
      size="xs"
      variant="glass"
      aria-label={gt("Save selection as shortcut")}
      onClick={() => {
        window.getSelection()?.removeAllRanges();
        onDone();
        openPromptShortcutEditor({
          environmentId: threadRef.environmentId,
          shortcut: null,
          content: text,
        });
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onDone();
        }
      }}
    >
      <ZapIcon aria-hidden="true" className="size-3.5" />
      {gt("Shortcut", { $context: "button that saves the selected text as a prompt shortcut" })}
    </Button>
  );
}
