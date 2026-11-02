// fork: Settings → Maintenance → "Import from T3 Code".
import {
  AuthEnvironmentMaintainScope,
  type EnvironmentId,
  type ProjectId,
  type T3CodeImportPreview,
  type T3CodeImportResult,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { settingsScopeEnvironmentLabel } from "../components/settings/settingsScopeAxis";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { searchableSetting } from "../components/settings/settingsSearch";
import { useT } from "../hooks/useT";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

type Available = Extract<T3CodeImportPreview, { readonly status: "available" }>;
type Unavailable = Extract<T3CodeImportPreview, { readonly status: "unavailable" }>;

type Step =
  | { readonly kind: "closed" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unavailable"; readonly reason: Unavailable["reason"] }
  | {
      readonly kind: "choose";
      readonly preview: Available;
      readonly selected: ReadonlySet<ProjectId>;
    }
  | { readonly kind: "importing" }
  | { readonly kind: "done"; readonly result: T3CodeImportResult };

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function ImportRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly searchable: boolean;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>({ kind: "closed" });
  const preview = useAtomCommand(serverEnvironment.previewT3CodeImport);
  const run = useAtomCommand(serverEnvironment.runT3CodeImport);
  const allowed = useEnvironmentScope(props.environmentId, AuthEnvironmentMaintainScope);

  const open = async () => {
    setStep({ kind: "loading" });
    const result = await preview({ environmentId: props.environmentId, input: {} });
    if (result._tag !== "Success") {
      if (isAtomCommandInterrupted(result)) return setStep({ kind: "closed" });
      return setStep({
        kind: "failed",
        message: errorMessage(squashAtomCommandFailure(result)),
      });
    }
    const value = result.value;
    if (value.status === "unavailable") {
      return setStep({ kind: "unavailable", reason: value.reason });
    }
    setStep({
      kind: "choose",
      preview: value,
      selected: new Set(
        value.projects.filter((project) => project.importableThreads > 0).map((p) => p.projectId),
      ),
    });
  };

  const startImport = async (projectIds: ReadonlyArray<ProjectId>) => {
    const [first, ...rest] = projectIds;
    if (first === undefined) return;
    setStep({ kind: "importing" });
    const result = await run({
      environmentId: props.environmentId,
      input: { projectIds: [first, ...rest] },
    });
    if (result._tag === "Success") return setStep({ kind: "done", result: result.value });
    if (isAtomCommandInterrupted(result)) return setStep({ kind: "closed" });
    toastManager.add({
      type: "error",
      title: t("Could not import from T3 Code"),
      description: errorMessage(squashAtomCommandFailure(result)),
    });
    void open();
  };

  const close = () => {
    if (step.kind !== "importing") setStep({ kind: "closed" });
  };

  const unavailableText = (reason: Unavailable["reason"]) => {
    switch (reason) {
      case "source-missing":
        return t("No T3 Code data was found on this computer.");
      case "source-is-this-database":
        return t(
          "This environment already uses T3 Code's data folder, so there is nothing to import.",
        );
      case "source-schema-newer":
        return t(
          "T3 Code's data comes from a newer version than this app understands. Update this app first.",
        );
      case "source-schema-older":
        return t(
          "T3 Code's data comes from an older version. Open T3 Code once so it updates its data, then try again.",
        );
    }
  };

  return (
    <>
      <SettingsRow
        {...(props.searchable
          ? searchableSetting("import-from-t3-code")
          : { title: t("Import from T3 Code") })}
        description={t(
          "Bring your projects and threads from T3 Code on this computer into T3 Extend. T3 Code's own data is only read, never changed.",
        )}
        status={props.label === "" ? undefined : props.label}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!allowed || step.kind === "loading" || step.kind === "importing"}
            onClick={() => void open()}
          >
            {step.kind === "loading" ? t("Looking…") : t("Review…")}
          </Button>
        }
      />
      <Dialog
        open={step.kind !== "closed" && step.kind !== "loading"}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogPopup className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Import from T3 Code")}</DialogTitle>
            <DialogDescription>
              {step.kind === "done"
                ? t("Finished.")
                : t(
                    "Choose which projects to bring over. Threads you already imported are skipped.",
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {step.kind === "failed" && (
              <Alert variant="error">
                <AlertDescription>{step.message}</AlertDescription>
              </Alert>
            )}
            {step.kind === "unavailable" && (
              <Alert variant="warning">
                <AlertDescription>{unavailableText(step.reason)}</AlertDescription>
              </Alert>
            )}
            {step.kind === "importing" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner size="md" />
                {t("Importing… this can take a few minutes for a large history.")}
              </div>
            )}
            {step.kind === "choose" && (
              <ProjectChoices
                preview={step.preview}
                selected={step.selected}
                onToggle={(projectId) =>
                  setStep((current) => {
                    if (current.kind !== "choose") return current;
                    const selected = new Set(current.selected);
                    if (!selected.delete(projectId)) selected.add(projectId);
                    return { ...current, selected };
                  })
                }
              />
            )}
            {step.kind === "done" && <Summary result={step.result} />}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={step.kind === "importing"} onClick={close}>
              {step.kind === "done" ? t("Close") : t("Cancel")}
            </Button>
            {step.kind === "choose" && (
              <Button
                disabled={threadCount(step.preview, step.selected) === 0}
                onClick={() => void startImport([...step.selected])}
              >
                {t("Import {count} threads", { count: threadCount(step.preview, step.selected) })}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

const threadCount = (preview: Available, selected: ReadonlySet<ProjectId>) =>
  preview.projects.reduce(
    (sum, project) => sum + (selected.has(project.projectId) ? project.importableThreads : 0),
    0,
  );

function ProjectChoices(props: {
  readonly preview: Available;
  readonly selected: ReadonlySet<ProjectId>;
  readonly onToggle: (projectId: ProjectId) => void;
}) {
  const t = useT();
  if (props.preview.projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t("T3 Code has no projects to import.")}</p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {props.preview.projects.map((project) => {
        const nothingNew = project.importableThreads === 0;
        return (
          <li key={project.projectId}>
            <label className="flex cursor-pointer items-start gap-3 py-2.5">
              <Checkbox
                className="mt-0.5"
                checked={props.selected.has(project.projectId)}
                disabled={nothingNew}
                onCheckedChange={() => props.onToggle(project.projectId)}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium">{project.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {nothingNew
                      ? t("Nothing new")
                      : t("{count} threads", { count: project.importableThreads })}
                  </span>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {project.workspaceRoot}
                </span>
                {project.joinsProjectId !== null && !nothingNew && (
                  <span className="text-xs text-muted-foreground">
                    {t("Joins the project you already have for this folder.")}
                  </span>
                )}
                {project.existingThreads > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t("{count} threads already imported.", { count: project.existingThreads })}
                  </span>
                )}
                {project.busyThreads > 0 && (
                  <span className="text-xs text-warning-foreground">
                    {t("{count} threads are still working in T3 Code and will be skipped.", {
                      count: project.busyThreads,
                    })}
                  </span>
                )}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function Summary(props: { readonly result: T3CodeImportResult }) {
  const t = useT();
  const { result } = props;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {t("Imported {threads} threads and {projects} new projects.", {
          threads: result.importedThreads,
          projects: result.importedProjects,
        })}
      </p>
      {result.busyThreads > 0 && (
        <p className="text-muted-foreground">
          {t(
            "{count} threads were skipped because T3 Code is still working on them. Stop them there and import again.",
            { count: result.busyThreads },
          )}
        </p>
      )}
      <p className="text-muted-foreground">
        {t("Threads keep working in the folders they used. Open them from the sidebar.")}
      </p>
    </div>
  );
}

export function T3CodeImportSection() {
  const { connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.t3CodeImport === true,
  );
  if (supported.length === 0) return null;
  return (
    <SettingsSection id="import-from-t3-code" title="Import from T3 Code">
      {supported.map((environment, index) => (
        <ImportRow
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={
            supported.length > 1
              ? settingsScopeEnvironmentLabel(environment, connectedEnvironments)
              : ""
          }
          searchable={index === 0}
        />
      ))}
    </SettingsSection>
  );
}
