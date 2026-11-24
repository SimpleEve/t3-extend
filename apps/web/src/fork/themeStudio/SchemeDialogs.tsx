import { useState } from "react";

import { useT } from "../../hooks/useT";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
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
import type { useThemeStudio } from "./useThemeStudio";

type Studio = ReturnType<typeof useThemeStudio>;

const MAX_NAME_LENGTH = 48;

function SaveFailedNote({ failed }: { failed: boolean }) {
  const t = useT();
  return failed ? (
    <p aria-live="polite" className="text-xs text-destructive">
      {t("Could not save the scheme. Browser storage may be unavailable or full.")}
    </p>
  ) : null;
}

function SchemeNameField({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (name: string) => void;
  onSubmit: () => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <Label htmlFor="theme-scheme-name">{t("Scheme name")}</Label>
      <Input
        autoFocus
        id="theme-scheme-name"
        maxLength={MAX_NAME_LENGTH}
        onChange={(event) => onChange(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
        }}
        value={value}
      />
    </div>
  );
}

function NameForm({
  initialName,
  failed,
  onCancel,
  onSave,
}: {
  initialName: string;
  failed: boolean;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const submit = () => {
    if (name.trim() !== "") onSave(name);
  };
  return (
    <>
      <DialogPanel>
        <div className="space-y-2">
          <SchemeNameField onChange={setName} onSubmit={submit} value={name} />
          <SaveFailedNote failed={failed} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button disabled={name.trim() === ""} onClick={submit}>
          {t("Save")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Asks for a name and saves what is on screen as a new scheme. */
export function SaveSchemeDialog({
  studio,
  open,
  onOpenChange,
}: {
  studio: Studio;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Save as a new scheme")}</DialogTitle>
          <DialogDescription>
            {t(
              "Keeps these colors, fonts, layout and CSS under this name. The preset and your other schemes stay as they are.",
            )}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <NameForm
            failed={studio.saveFailed}
            initialName={studio.suggestedName}
            onCancel={() => onOpenChange(false)}
            onSave={(name) => {
              if (studio.saveAs(name)) onOpenChange(false);
            }}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/** The body of the switch dialog; mounted while it is open, so the name starts from the suggestion. */
function UnsavedSwitchBody({
  studio,
  pending,
}: {
  studio: Studio;
  pending: NonNullable<Studio["pendingSwitch"]>;
}) {
  const t = useT();
  const [name, setName] = useState(studio.suggestedName);
  // A scheme that was never saved needs a name; a saved one is written back under its own.
  const needsName = studio.isFork;
  const canSave = !needsName || name.trim() !== "";
  const save = () => {
    if (canSave) studio.resolveSwitch("save", name);
  };
  const params = { target: pending.targetName, name: studio.labelOf(studio.working) };
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{t("Save your changes first?")}</AlertDialogTitle>
        <AlertDialogDescription>
          {pending.sameTheme
            ? t(
                "Going back to {target} drops the changes you made to {name}. Save them as a scheme to keep them.",
                params,
              )
            : t(
                "Switching to {target} drops the changes you made to {name}. Save them as a scheme to keep them.",
                params,
              )}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {needsName ? (
        <div className="px-6 pb-4">
          <SchemeNameField onChange={setName} onSubmit={save} value={name} />
        </div>
      ) : null}
      {studio.saveFailed ? (
        <div className="px-6 pb-4">
          <SaveFailedNote failed />
        </div>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>
          {t("Keep editing")}
        </AlertDialogClose>
        <Button variant="destructive-outline" onClick={() => studio.resolveSwitch("discard")}>
          {t("Discard changes")}
        </Button>
        <Button disabled={!canSave} onClick={save}>
          {t("Save and switch")}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

/** Switching theme while the studio holds unsaved changes: save them, drop them, or stay. */
export function UnsavedSwitchDialog({ studio }: { studio: Studio }) {
  const pending = studio.pendingSwitch;
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) studio.resolveSwitch("keep");
      }}
      open={pending !== null}
    >
      <AlertDialogPopup>
        {pending ? <UnsavedSwitchBody pending={pending} studio={studio} /> : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
