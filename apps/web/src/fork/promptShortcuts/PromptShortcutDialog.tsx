import {
  MAX_PROMPT_SHORTCUT_CONTENT_LENGTH,
  MAX_PROMPT_SHORTCUT_NAME_LENGTH,
  MAX_PROMPT_SHORTCUT_TITLE_LENGTH,
  MAX_PROMPT_SHORTCUTS,
} from "@t3tools/contracts";
import {
  normalizePromptShortcutName,
  validatePromptShortcutName,
} from "@t3tools/shared/promptShortcuts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { toastManager } from "../../components/ui/toast";
import { PromptShortcutContentEditor } from "./PromptShortcutContentEditor";
import {
  closePromptShortcutEditor,
  usePromptShortcutEditorStore,
  type PromptShortcutEditorTarget,
} from "./promptShortcutEditorStore";
import { usePromptShortcutActions, usePromptShortcuts } from "./usePromptShortcutActions";

const EXAMPLE_NAME = "review";

/** Mounted once at the app root; Settings, the chat view and the command palette open it. */
export function PromptShortcutDialogHost() {
  const target = usePromptShortcutEditorStore((state) => state.target);
  return target ? (
    <PromptShortcutDialog
      // A new target is a new form: its fields start from the target, not from the last one.
      key={`${target.environmentId}:${target.shortcut?.id ?? "new"}:${target.content ?? ""}`}
      target={target}
    />
  ) : null;
}

function PromptShortcutDialog({ target }: { target: PromptShortcutEditorTarget }) {
  const gt = useGT();
  const { environmentId, shortcut } = target;
  const shortcuts = usePromptShortcuts(environmentId);
  const actions = usePromptShortcutActions(environmentId);
  const [name, setName] = useState(shortcut?.name ?? "");
  const [title, setTitle] = useState(shortcut?.title ?? "");
  const [content, setContent] = useState(shortcut?.content ?? target.content ?? "");
  const [saving, setSaving] = useState(false);

  const nameProblem = validatePromptShortcutName(
    name,
    shortcuts.filter((entry) => entry.id !== shortcut?.id).map((entry) => entry.name),
  );
  const limitReached = shortcut === null && shortcuts.length >= MAX_PROMPT_SHORTCUTS;
  const contentTooLong = content.trim().length > MAX_PROMPT_SHORTCUT_CONTENT_LENGTH;
  const nameMessage =
    nameProblem === "format"
      ? gt("Use lowercase letters, numbers and hyphens only.")
      : nameProblem === "too-long"
        ? gt("Use at most {max} characters.", { max: MAX_PROMPT_SHORTCUT_NAME_LENGTH })
        : nameProblem === "duplicate"
          ? gt("Another shortcut is already named :{name}.", {
              name: normalizePromptShortcutName(name),
            })
          : null;
  const canSave =
    nameProblem === null &&
    content.trim().length > 0 &&
    !contentTooLong &&
    !limitReached &&
    actions.canWrite &&
    !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const saved = await actions.save({ id: shortcut?.id ?? null, name, title, content });
    setSaving(false);
    if (saved === null) return;
    closePromptShortcutEditor();
    if (shortcut === null) {
      toastManager.add({
        type: "success",
        title: gt("Prompt shortcut saved"),
        description: gt("Type :{name} in the composer to use it.", { name: saved.name }),
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closePromptShortcutEditor();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {shortcut ? <T>Edit prompt shortcut</T> : <T>New prompt shortcut</T>}
          </DialogTitle>
          <DialogDescription>
            <T>Type : and its name in the composer to insert this prompt.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="prompt-shortcut-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-shortcut-name">
                <T>Name</T>
              </Label>
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="text-sm text-muted-foreground">
                  :
                </span>
                <Input
                  id="prompt-shortcut-name"
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={name}
                  maxLength={MAX_PROMPT_SHORTCUT_NAME_LENGTH * 2}
                  placeholder={EXAMPLE_NAME}
                  aria-invalid={name !== "" && nameProblem !== null}
                  aria-describedby="prompt-shortcut-name-hint"
                  onChange={(event) =>
                    setName(event.target.value.replace(/^[:：]/, "").toLowerCase())
                  }
                />
              </div>
              <p
                id="prompt-shortcut-name-hint"
                className={
                  name !== "" && nameMessage
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {name !== "" && nameMessage
                  ? nameMessage
                  : gt("Lowercase letters, numbers and hyphens.")}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-shortcut-title">
                <T>Title</T>
                <span className="font-normal text-muted-foreground">
                  <T>(optional)</T>
                </span>
              </Label>
              <Input
                id="prompt-shortcut-title"
                value={title}
                maxLength={MAX_PROMPT_SHORTCUT_TITLE_LENGTH}
                placeholder={gt("Review the current changes")}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>
                <T>Prompt</T>
              </Label>
              <PromptShortcutContentEditor
                environmentId={environmentId}
                cwd={target.cwd}
                value={content}
                onChange={setContent}
                onSubmit={() => void save()}
                ariaLabel={gt("Prompt")}
                placeholder={gt("Write the prompt. Type $ for skills or @ for files.")}
              />
              {contentTooLong ? (
                <p className="text-xs text-destructive">
                  {gt("The prompt is too long. Keep it under {max} characters.", {
                    max: MAX_PROMPT_SHORTCUT_CONTENT_LENGTH,
                  })}
                </p>
              ) : null}
              {limitReached ? (
                <p className="text-xs text-destructive">
                  {gt("You can save up to {max} prompt shortcuts. Remove one to add another.", {
                    max: MAX_PROMPT_SHORTCUTS,
                  })}
                </p>
              ) : null}
              {actions.canWrite ? null : (
                <p className="text-xs text-muted-foreground">
                  <T>This connection can't change settings.</T>
                </p>
              )}
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={closePromptShortcutEditor}>
            <T>Cancel</T>
          </Button>
          <Button type="submit" form="prompt-shortcut-form" disabled={!canSave}>
            <T>Save</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
