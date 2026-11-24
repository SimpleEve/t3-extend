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

function NameForm({
  initialName,
  onCancel,
  onSave,
}: {
  initialName: string;
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
          <Label htmlFor="theme-scheme-name">{t("Scheme name")}</Label>
          <Input
            autoFocus
            id="theme-scheme-name"
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => setName(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            value={name}
          />
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

/** Switching theme while the studio holds unsaved changes: save them, drop them, or stay. */
export function UnsavedSwitchDialog({ studio }: { studio: Studio }) {
  const t = useT();
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) studio.resolveSwitch("keep");
      }}
      open={studio.pendingSwitch !== null}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Save your changes first?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "Switching to another theme drops the changes you made to {name}. Save them as a scheme to keep them.",
              { name: studio.labelOf(studio.working) },
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            {t("Keep editing")}
          </AlertDialogClose>
          <Button variant="destructive-outline" onClick={() => studio.resolveSwitch("discard")}>
            {t("Discard changes")}
          </Button>
          <Button onClick={() => studio.resolveSwitch("save")}>{t("Save and switch")}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
