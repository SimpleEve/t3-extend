import { DownloadIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useT } from "../../hooks/useT";
import { serializeThemeFile, type ThemeDefinition } from "../../themePalette";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SettingsSection } from "../../components/settings/settingsLayout";
import { downloadThemeFile } from "../../components/settings/ThemeSettings";
import { ThemeImportDialog } from "../../components/settings/ThemeImportDialog";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { verbatim } from "../verbatim";
import { HalvesNotice } from "./HalvesNotice";
import type { useThemeStudio } from "./useThemeStudio";

type Studio = ReturnType<typeof useThemeStudio>;

function SchemeRow({
  studio,
  scheme,
  pending,
}: {
  studio: Studio;
  scheme: ThemeDefinition;
  /** A fork that has not been applied yet, so it is not in the library. */
  pending: boolean;
}) {
  const t = useT();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const active = studio.applied?.id === scheme.id && studio.draft === null;
  const origin = scheme.basedOn ? studio.presetLabel(scheme.basedOn) : null;

  const commitRename = () => {
    if (renaming !== null) studio.rename(scheme, renaming);
    setRenaming(null);
  };

  return (
    <div
      className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:px-4"
      data-theme-scheme={scheme.id}
    >
      <div className="min-w-0 flex-1">
        {renaming !== null ? (
          <Input
            autoFocus
            aria-label={t("Scheme name")}
            maxLength={48}
            onBlur={commitRename}
            onChange={(event) => setRenaming(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") {
                event.stopPropagation();
                setRenaming(null);
              }
            }}
            size="sm"
            value={renaming}
          />
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{verbatim(scheme.label)}</span>
            {active ? (
              <Badge size="sm" variant="success">
                {t("In use")}
              </Badge>
            ) : null}
            {pending ? (
              <Badge size="sm" variant="warning">
                {t("Not applied yet")}
              </Badge>
            ) : null}
          </div>
        )}
        {origin !== null && renaming === null ? (
          <p className="truncate text-xs text-muted-foreground">
            {t("Based on {name}", { name: origin })}
          </p>
        ) : null}
      </div>
      {pending ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            disabled={active}
            size="xs"
            variant="outline"
            onClick={() => studio.select(scheme.id)}
          >
            {t("Use")}
          </Button>
          <Button
            aria-label={t("Rename {name}", { name: scheme.label })}
            size="icon-xs"
            variant="ghost"
            onClick={() => setRenaming(scheme.label)}
          >
            <PencilIcon />
          </Button>
          <Button
            aria-label={t("Export {name} as JSON", { name: scheme.label })}
            size="icon-xs"
            variant="ghost"
            onClick={() => downloadThemeFile(`${scheme.id}.json`, serializeThemeFile(scheme))}
          >
            <DownloadIcon />
          </Button>
          {confirmingDelete ? (
            <>
              <Button
                size="xs"
                variant="destructive-outline"
                onClick={() => {
                  setConfirmingDelete(false);
                  studio.remove(scheme);
                }}
              >
                {t("Delete")}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                {t("Cancel")}
              </Button>
            </>
          ) : (
            <Button
              aria-label={t("Delete {name}", { name: scheme.label })}
              size="icon-xs"
              variant="ghost"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function MySchemes({ studio }: { studio: Studio }) {
  const t = useT();
  const [importOpen, setImportOpen] = useState(false);
  // Imported VS Code themes belong to collections and are managed from Appearance.
  const schemes = studio.customThemes.filter((theme) => theme.collection === undefined);
  const pending = studio.isFork ? studio.draft : null;
  return (
    <SettingsSection
      id="theme-studio-schemes"
      title="My schemes"
      headerAction={
        <Button size="xs" variant="outline" onClick={() => setImportOpen(true)}>
          <PlusIcon />
          {t("Import")}
        </Button>
      }
    >
      {studio.halvesInUse ? (
        <div className="px-3 pt-3 sm:px-4">
          <HalvesNotice studio={studio} />
        </div>
      ) : null}
      {pending ? <SchemeRow pending scheme={pending} studio={studio} /> : null}
      {schemes.map((scheme) => (
        <SchemeRow key={scheme.id} pending={false} scheme={scheme} studio={studio} />
      ))}
      {schemes.length === 0 && pending === null ? (
        <p className="px-3 py-4 text-sm text-muted-foreground sm:px-4">
          {t("Nothing here yet. Change a preset above and your version is saved here.")}
        </p>
      ) : null}
      <ThemeImportDialog
        onImported={(imported) => {
          if (!studio.select(imported.id)) return false;
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: t("{label} added", { label: imported.label }),
              description: t("It’s now active."),
            }),
          );
          return true;
        }}
        onImportedMany={(imported, { updated }) =>
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title:
                imported.length === 1
                  ? updated
                    ? t("{label} updated", { label: imported[0]!.label })
                    : t("{label} added", { label: imported[0]!.label })
                  : t("{count} themes added", { count: imported.length }),
              description: imported.map((theme) => theme.label).join(", "),
            }),
          )
        }
        onOpenChange={setImportOpen}
        open={importOpen}
      />
    </SettingsSection>
  );
}
