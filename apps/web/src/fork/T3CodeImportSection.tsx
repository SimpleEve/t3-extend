// fork: Settings → Maintenance → "Import from T3 Code".
import {
  AuthEnvironmentMaintainScope,
  type EnvironmentId,
  type ProjectId,
  type T3CodeImportCatalog,
  type T3CodeImportFileKind,
  type T3CodeImportNotice,
  type T3CodeImportReport,
  type T3CodeImportResult,
  type T3CodeImportSelection,
  type ThreadId,
  OFFICIAL_APP_NAME,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
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
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { settingsScopeEnvironmentLabel } from "../components/settings/settingsScopeAxis";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { searchableSetting } from "../components/settings/settingsSearch";
import { useT } from "../hooks/useT";
import { updateClientSettings } from "../hooks/useSettings";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

type Available = Extract<T3CodeImportCatalog, { readonly status: "available" }>;
type Unavailable = Extract<T3CodeImportCatalog, { readonly status: "unavailable" }>;

interface Draft {
  readonly threads: ReadonlySet<ThreadId>;
  readonly emptyProjects: ReadonlySet<ProjectId>;
  readonly includeArchived: boolean;
  readonly includeSubagents: boolean;
  /** Task id → whether it is imported, and whether it runs. */
  readonly tasks: ReadonlyMap<string, { readonly picked: boolean; readonly enabled: boolean }>;
  readonly files: ReadonlySet<T3CodeImportFileKind>;
}

type Step =
  | { readonly kind: "closed" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unavailable"; readonly reason: Unavailable["reason"] }
  | { readonly kind: "choose"; readonly catalog: Available; readonly draft: Draft }
  | {
      readonly kind: "review";
      readonly catalog: Available;
      readonly draft: Draft;
      readonly report: T3CodeImportReport | null;
    }
  | { readonly kind: "running" };

const FILE_KINDS: ReadonlyArray<T3CodeImportFileKind> = [
  "settings",
  "providerInstances",
  "usagePriceOverrides",
  "clientSettings",
  "keybindings",
  "themes",
];

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

type CatalogThread = Available["projects"][number]["threads"][number];

/** Threads a bulk pick may take: new ones and updated ones whose copy here has nothing of yours in it. */
const isBulkSelectable = (thread: CatalogThread) =>
  thread.state === "importable" ||
  (thread.state === "updated" && thread.localChanges === 0 && thread.localEdits.length === 0);

const draftFor = (catalog: Available): Draft => ({
  threads: new Set(
    catalog.projects.flatMap((project) =>
      project.threads
        .filter((thread) => isBulkSelectable(thread) && !thread.archived)
        .map((thread) => thread.threadId),
    ),
  ),
  emptyProjects: new Set(),
  includeArchived: false,
  includeSubagents: true,
  tasks: new Map(
    catalog.scheduledTasks.map((task) => [
      task.taskId,
      { picked: !task.alreadyImported, enabled: task.enabled },
    ]),
  ),
  files: new Set(catalog.files.filter((file) => file.available).map((file) => file.kind)),
});

const selectionFrom = (catalog: Available, draft: Draft): T3CodeImportSelection => ({
  threadIds: catalog.projects.flatMap((project) =>
    project.threads
      .filter(
        (thread) =>
          draft.threads.has(thread.threadId) && (draft.includeArchived || !thread.archived),
      )
      .map((thread) => thread.threadId),
  ),
  projectIds: [...draft.emptyProjects],
  includeSubagents: draft.includeSubagents,
  scheduledTasks: catalog.scheduledTasks.flatMap((task) => {
    const choice = draft.tasks.get(task.taskId);
    return choice?.picked === true ? [{ taskId: task.taskId, enabled: choice.enabled }] : [];
  }),
  files: [...draft.files],
});

/** What a replacement would undo, in words: the runs started here and the edits made to the copy. */
function localChangesText(
  t: ReturnType<typeof useT>,
  runs: number,
  edits: ReadonlyArray<string>,
): string {
  const parts: Array<string> = [];
  if (runs > 0) {
    parts.push(
      runs === 1
        ? t("{count} run you started", { count: runs })
        : t("{count} runs you started", { count: runs }),
    );
  }
  for (const edit of edits) {
    switch (edit) {
      case "pinned":
        parts.push(t("a changed pin"));
        break;
      case "archived":
        parts.push(t("a changed archive state"));
        break;
      case "snoozed":
        parts.push(t("a changed snooze"));
        break;
      case "settings":
        parts.push(t("changed mode or model settings"));
        break;
    }
  }
  return parts.join(", ");
}

function NoticeText(props: { readonly notice: T3CodeImportNotice }) {
  const t = useT();
  const { subject, detail = "", count = 0 } = props.notice;
  const app = OFFICIAL_APP_NAME;
  const one = count === 1;
  switch (props.notice.code) {
    case "project-merged":
      return t("{subject} joins the project you already have for {detail}.", { subject, detail });
    case "thread-ids-renewed":
      return one
        ? t(
            "{count} thread gets a new id, so {app} and T3 Extend keep separate histories and checkpoints.",
            { app, count },
          )
        : t(
            "{count} threads get new ids, so {app} and T3 Extend keep separate histories and checkpoints.",
            { app, count },
          );
    case "parents-pulled-in":
      return one
        ? t("{count} parent thread comes along because a thread you picked was forked from it.", {
            count,
          })
        : t(
            "{count} parent threads come along because the threads you picked were forked from them.",
            { count },
          );
    case "checkpoint-refs-copied":
      return one
        ? t("{count} checkpoint ref is copied under a new name in your repositories.", { count })
        : t("{count} checkpoint refs are copied under new names in your repositories.", { count });
    case "limit-recovery-cleared":
      return one
        ? t(
            "{count} thread had automatic usage-limit resume turned off, so it only runs when you continue it.",
            { count },
          )
        : t(
            "{count} threads had automatic usage-limit resume turned off, so they only run when you continue them.",
            { count },
          );
    case "provider-session-detached":
      return one
        ? t(
            "{count} thread arrives stopped: its live provider session and pending requests stay in {app}.",
            { app, count },
          )
        : t(
            "{count} threads arrive stopped: live provider sessions and pending requests stay in {app}.",
            { app, count },
          );
    case "paths-rewritten":
      return one
        ? t("{count} path into {app}'s folder now points into T3 Extend's.", { app, count })
        : t("{count} paths into {app}'s folder now point into T3 Extend's.", { app, count });
    case "attachments-copied":
      return one
        ? t("{count} attachment or browser capture is copied with its thread.", { count })
        : t("{count} attachments and browser captures are copied with their threads.", { count });
    case "task-imported-active":
      return t("{subject} is imported and active. Its first run is at its next scheduled time.", {
        subject,
      });
    case "thread-refreshed":
      return one
        ? t("{count} thread is updated in place from {app}. It keeps its place in the sidebar.", {
            app,
            count,
          })
        : t(
            "{count} threads are updated in place from {app}. They keep their place in the sidebar.",
            {
              app,
              count,
            },
          );
    case "identity-skipped":
      return subject
        ? t(
            "Identity stays with {app}: {subject}, plus sessions, pairing links and linked environments. Phones and browsers pair with T3 Extend again.",
            { app, subject },
          )
        : t(
            "Identity stays with {app}: sessions, pairing links and linked environments. Phones and browsers pair with T3 Extend again.",
            { app },
          );
    case "signing-secrets-skipped":
      return one
        ? t("{count} signing key or cloud sign-in secret belongs to {app}'s identity.", {
            app,
            count,
          })
        : t("{count} signing keys and cloud sign-in secrets belong to {app}'s identity.", {
            app,
            count,
          });
    case "connection-catalog-skipped":
      return t("Saved remote environments are encrypted with {app}'s key. Add them again here.", {
        app,
      });
    case "desktop-settings-skipped":
      return t("Window size and position belong to the {app} window.", { app });
    case "browser-profile-skipped":
      return t("The built-in browser's logins cannot be read by T3 Extend. Sign in again.");
    case "browser-storage-skipped":
      return t(
        "Unsent drafts, collapsed groups and other per-device state live in {app}'s own window and cannot be reached.",
        { app },
      );
    case "thread-busy":
      return t("{subject}: {app} is working on it right now. Stop it there and import again.", {
        app,
        subject,
      });
    case "thread-parent-busy":
      return t("{subject}: its parent thread is busy in {app}.", { app, subject });
    case "thread-target-busy":
      return t(
        "{subject}: it is running or has queued work here, so it is not replaced. Let it finish and import again.",
        { subject },
      );
    case "thread-target-changed":
      return t(
        "{subject}: it changed here after the review, so it is not replaced. Review and import again.",
        { subject },
      );
    case "thread-target-session":
      return t(
        "{subject}: its session here is still open, so it is not replaced. Close this thread's session and import again.",
        { subject },
      );
    case "task-project-missing":
      return t("{subject}: its project is not part of this import.", { subject });
    case "task-thread-missing":
      return t("{subject}: the thread it belongs to is not part of this import.", { subject });
    case "task-unreadable":
      return t("{subject}: its definition could not be read here.", { subject });
    case "setting-rejected":
      return t("{subject} is not a setting T3 Extend can take.", { subject });
    case "setting-managed":
      return t("{subject} is managed by {detail} and cannot be changed by an import.", {
        subject,
        detail,
      });
    case "provider-instance-managed":
      return t("Provider {subject} is not allowed by {detail}'s policy.", { subject, detail });
    case "client-setting-rejected":
      return t("{subject} is not an interface preference T3 Extend knows.", { subject });
    case "keybinding-rejected":
      return t("The shortcut for {subject} was not valid.", { subject });
    case "worktree-directories-skipped":
      return t("{subject}: T3 Extend never cleans up folders it did not create.", { subject });
    case "relay-state-skipped":
      return t("Webhook delivery history and replay state stay in {app}.", { app });
    case "provider-instance-exists":
      return t("Provider {subject} already exists here and is left as it is.", { subject });
    case "worktree-missing":
      return one
        ? t(
            "{count} worktree no longer exists on disk ({detail}). Its thread opens without files.",
            { count, detail },
          )
        : t(
            "{count} worktrees no longer exist on disk ({detail}). Their threads open without files.",
            { count, detail },
          );
    case "worktree-shared":
      return one
        ? t("{count} worktree stays where it is, shared with {app}. T3 Extend never deletes it.", {
            app,
            count,
          })
        : t(
            "{count} worktrees stay where they are, shared with {app}. T3 Extend never deletes them.",
            { app, count },
          );
    case "provider-files-shared":
      return one
        ? t(
            "Continue this thread in only one app: both would write the same provider session files (for example under ~/.claude and ~/.codex).",
          )
        : t(
            "Continue each of these {count} threads in only one app: both would write the same provider session files (for example under ~/.claude and ~/.codex).",
            { count },
          );
    case "task-runs-in-both":
      return t("{subject} keeps running in {app} too until you pause it there.", { app, subject });
    case "task-once-passed":
      return t(
        "{subject} was a one-time task whose time has already passed. It is imported turned off so it does not run right away.",
        { subject },
      );
    case "task-webhook-url":
      return t(
        "{subject}: its webhook URL changed. It now listens at {detail} on this environment's address. Update the sender.",
        { subject, detail },
      );
    case "task-webhook-secret":
      return t(
        "{subject}: its signing secret changed to {detail}. Set it in the sender; it is shown only now.",
        { subject, detail },
      );
    case "subagents-omitted":
      return one
        ? t(
            "{count} subagent thread is left out. Its card in the parent thread stays but cannot be opened.",
            { count },
          )
        : t(
            "{count} subagent threads are left out. Their cards in the parent threads stay but cannot be opened.",
            { count },
          );
    case "checkpoint-refs-unavailable":
      return one
        ? t(
            "{count} checkpoint could not be copied because its repository is gone. It shows as missing.",
            { count },
          )
        : t(
            "{count} checkpoints could not be copied because their repository is gone. They show as missing.",
            { count },
          );
    case "checkpoint-refs-conflict":
      return one
        ? t(
            "{count} checkpoint was left out because the name it would take already points to a different commit. It shows as missing.",
            { count },
          )
        : t(
            "{count} checkpoints were left out because the names they would take already point to different commits. They show as missing.",
            { count },
          );
    case "thread-local-discarded":
      return t(
        "{subject}: replacing it discards what you changed here since the last import: {changes}.",
        { subject, changes: localChangesText(t, count, detail === "" ? [] : detail.split(",")) },
      );
    case "thread-large-replace":
      return t(
        "{subject}: it is a long thread, so replacing it may briefly pause your other threads while it is copied.",
        { subject },
      );
    case "thread-title-replaced":
      return t("{subject}: its title here goes back to the one in {app}.", { app, subject });
    case "thread-replace-idle":
      return t(
        "Importing again replaces the copy here. Do it only while the thread is idle: anything still being written to it at that moment can be lost.",
      );
    case "provider-credential-imported":
      return one
        ? t("{subject}: its sign-in credential is copied together with the provider.", { subject })
        : t("{subject}: their sign-in credentials are copied together with their providers.", {
            subject,
          });
    case "sidebar-settings":
      return t("{app} used the legacy sidebar. It is on here too (Settings → Labs).", { app });
  }
}

function Report(props: { readonly report: T3CodeImportReport }) {
  const t = useT();
  const groups = [
    [t("Fixed automatically"), props.report.fixed],
    [t("Not imported"), props.report.skipped],
    [t("Imported, needs your attention"), props.report.attention],
  ] as const;
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([title, notices]) => (
        <section key={title} className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">
            {title} <span className="text-muted-foreground tabular-nums">({notices.length})</span>
          </h3>
          {notices.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("Nothing here.")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {notices.map((notice) => (
                <li key={`${notice.code}:${notice.subject}:${notice.detail ?? ""}`}>
                  <NoticeText notice={notice} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** What replacing a thread throws away is said first and apart: it cannot be undone. */
function ReviewReport(props: { readonly report: T3CodeImportReport }) {
  const t = useT();
  const discards = props.report.attention.filter(
    (notice) => notice.code === "thread-local-discarded",
  );
  if (discards.length === 0) return <Report report={props.report} />;
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="warning">
        <AlertDescription>
          <p className="font-medium">
            {t("Importing replaces what you changed here. This cannot be undone.")}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {discards.map((notice) => (
              <li key={notice.subject}>
                <NoticeText notice={notice} />
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
      <Report
        report={{
          ...props.report,
          attention: props.report.attention.filter(
            (notice) => notice.code !== "thread-local-discarded",
          ),
        }}
      />
    </div>
  );
}

function Progress(props: {
  readonly environmentId: EnvironmentId;
  readonly onFinished: (result: T3CodeImportResult) => void;
}) {
  const t = useT();
  const result = useAtomValue(
    serverEnvironment.t3CodeImportState({ environmentId: props.environmentId, input: {} }),
  );
  const state = result._tag === "Success" ? result.value : null;
  if (state?.status === "finished") {
    return <Finished result={state.result} onDone={() => props.onFinished(state.result)} />;
  }
  if (state?.status === "failed") {
    return (
      <Alert variant="error">
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  const running = state?.status === "running" ? state : null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Spinner size="md" />
        {running?.phase === "threads"
          ? t("Importing threads: {done} of {total}", {
              done: running.doneThreads,
              total: running.totalThreads,
            })
          : running?.phase === "files"
            ? t("Copying files and settings…")
            : running?.phase === "tasks"
              ? t("Importing scheduled tasks…")
              : t("Preparing…")}
      </div>
      {running?.currentTitle ? (
        <p className="truncate text-xs text-muted-foreground">{running.currentTitle}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t("You can keep using the app. Closing this window does not stop the import.")}
      </p>
    </div>
  );
}

function Finished(props: { readonly result: T3CodeImportResult; readonly onDone: () => void }) {
  const t = useT();
  const { result } = props;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        {t("Imported {threads} and {projects}.", {
          threads:
            result.importedThreads === 1
              ? t("{count} thread", { count: result.importedThreads })
              : t("{count} threads", { count: result.importedThreads }),
          projects:
            result.importedProjects === 1
              ? t("{count} new project", { count: result.importedProjects })
              : t("{count} new projects", { count: result.importedProjects }),
        })}
      </p>
      <Report report={result.report} />
      <Button className="self-start" variant="outline" size="sm" onClick={props.onDone}>
        {t("Done", undefined, "import dialog")}
      </Button>
    </div>
  );
}

function ProjectRow(props: {
  readonly project: Available["projects"][number];
  readonly draft: Draft;
  readonly onChange: (draft: Draft) => void;
}) {
  const t = useT();
  const { project, draft } = props;
  const selectable = project.threads.filter(
    (thread) => isBulkSelectable(thread) && (draft.includeArchived || !thread.archived),
  );
  const picked = selectable.filter((thread) => draft.threads.has(thread.threadId)).length;
  const isEmpty = project.threads.length === 0;
  const toggleAll = () => {
    if (isEmpty) {
      const emptyProjects = new Set(draft.emptyProjects);
      if (!emptyProjects.delete(project.projectId)) emptyProjects.add(project.projectId);
      props.onChange({ ...draft, emptyProjects });
      return;
    }
    const threads = new Set(draft.threads);
    for (const thread of selectable) {
      if (picked === selectable.length) threads.delete(thread.threadId);
      else threads.add(thread.threadId);
    }
    props.onChange({ ...draft, threads });
  };
  const toggleThread = (threadId: ThreadId) => {
    const threads = new Set(draft.threads);
    if (!threads.delete(threadId)) threads.add(threadId);
    props.onChange({ ...draft, threads });
  };
  return (
    <Collapsible>
      <div className="flex items-center gap-2 py-2">
        <Checkbox
          checked={
            isEmpty
              ? draft.emptyProjects.has(project.projectId)
              : selectable.length > 0 && picked === selectable.length
          }
          indeterminate={!isEmpty && picked > 0 && picked < selectable.length}
          disabled={!isEmpty && selectable.length === 0}
          aria-label={project.title}
          onCheckedChange={toggleAll}
        />
        <CollapsibleTrigger
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
          disabled={project.threads.length === 0}
        >
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{project.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {project.workspaceRoot}
              {project.joinsProjectId !== null ? ` · ${t("joins your existing project")}` : ""}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {t("{picked} of {total}", { picked, total: selectable.length })}
          </span>
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel>
        <ul className="ml-6 flex flex-col pb-2">
          {project.threads.map((thread) => {
            const disabled =
              (thread.state !== "importable" && thread.state !== "updated") ||
              (thread.archived && !draft.includeArchived);
            return (
              <li key={thread.threadId}>
                <label className="flex items-start gap-2 py-1">
                  <Checkbox
                    className="mt-0.5"
                    checked={draft.threads.has(thread.threadId) && !disabled}
                    disabled={disabled}
                    onCheckedChange={() => toggleThread(thread.threadId)}
                  />
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="block truncate">{thread.title || thread.threadId}</span>
                    <span className="block text-muted-foreground">
                      {[
                        thread.state === "imported" ? t("already imported") : null,
                        thread.state === "updated"
                          ? t("updated in {app}", { app: OFFICIAL_APP_NAME })
                          : null,
                        thread.state === "busy"
                          ? t("busy in {app}", { app: OFFICIAL_APP_NAME })
                          : null,
                        thread.archived ? t("archived") : null,
                        thread.subagentCount > 0
                          ? thread.subagentCount === 1
                            ? t("{count} subagent", { count: thread.subagentCount })
                            : t("{count} subagents", { count: thread.subagentCount })
                          : null,
                        thread.worktree?.status === "missing" ? t("worktree is gone") : null,
                      ]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </span>
                    {thread.state === "updated" &&
                      (thread.localChanges > 0 || thread.localEdits.length > 0) && (
                        <span className="block text-warning-foreground">
                          {t(
                            "You changed this here ({changes}). Importing it again discards that.",
                            {
                              changes: localChangesText(t, thread.localChanges, thread.localEdits),
                            },
                          )}
                        </span>
                      )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ChooseStep(props: {
  readonly catalog: Available;
  readonly draft: Draft;
  readonly onChange: (draft: Draft) => void;
}) {
  const t = useT();
  const { catalog, draft } = props;
  // Same wording as the scheduled-task editor's schedule toggle.
  const scheduleKindLabel = (kind: string) =>
    kind === "fixed_time"
      ? t("At a time")
      : kind === "once"
        ? t("Once")
        : kind === "interval"
          ? t("Every interval")
          : kind === "webhook"
            ? t("On webhook")
            : kind;
  const toggleFile = (kind: T3CodeImportFileKind) => {
    const files = new Set(draft.files);
    if (!files.delete(kind)) files.add(kind);
    props.onChange({ ...draft, files });
  };
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t("Projects and threads")}</h3>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <label className="flex items-center gap-2">
            <Checkbox
              checked={draft.includeArchived}
              onCheckedChange={(value) =>
                props.onChange({ ...draft, includeArchived: value === true })
              }
            />
            {t("Archived threads")}
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={draft.includeSubagents}
              onCheckedChange={(value) =>
                props.onChange({ ...draft, includeSubagents: value === true })
              }
            />
            {t("Subagent threads")}
          </label>
        </div>
        {catalog.projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("{app} has no projects to import.", { app: OFFICIAL_APP_NAME })}
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {catalog.projects.map((project) => (
              <ProjectRow
                key={project.projectId}
                project={project}
                draft={draft}
                onChange={props.onChange}
              />
            ))}
          </div>
        )}
      </section>

      {catalog.scheduledTasks.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{t("Scheduled tasks")}</h3>
          <ul className="flex flex-col divide-y divide-border/60">
            {catalog.scheduledTasks.map((task) => {
              const choice = draft.tasks.get(task.taskId) ?? { picked: false, enabled: false };
              const update = (next: Partial<typeof choice>) =>
                props.onChange({
                  ...draft,
                  tasks: new Map(draft.tasks).set(task.taskId, { ...choice, ...next }),
                });
              return (
                <li key={task.taskId} className="flex flex-col gap-1 py-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={choice.picked}
                      disabled={task.alreadyImported}
                      aria-label={task.title}
                      onCheckedChange={(value) => update({ picked: value === true })}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {scheduleKindLabel(task.scheduleKind)}
                    </span>
                    <Switch
                      aria-label={t("Runs on its schedule")}
                      checked={choice.enabled}
                      disabled={!choice.picked}
                      onCheckedChange={(enabled) => update({ enabled })}
                    />
                  </div>
                  {choice.picked && (
                    <p className="ml-6 text-xs text-warning-foreground">
                      {t("{app} keeps running its own copy until you pause it there.", {
                        app: OFFICIAL_APP_NAME,
                      })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">{t("Settings")}</h3>
        {FILE_KINDS.map((kind) => {
          const available = catalog.files.find((file) => file.kind === kind)?.available === true;
          return (
            <label key={kind} className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={draft.files.has(kind) && available}
                disabled={!available}
                onCheckedChange={() => toggleFile(kind)}
              />
              {kind === "settings"
                ? t("Settings")
                : kind === "providerInstances"
                  ? t("Provider instances and their sign-ins")
                  : kind === "usagePriceOverrides"
                    ? t("Usage price overrides")
                    : kind === "clientSettings"
                      ? t("Interface preferences")
                      : kind === "keybindings"
                        ? t("Keyboard shortcuts")
                        : t("Themes")}
            </label>
          );
        })}
      </section>
    </div>
  );
}

function ImportRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly searchable: boolean;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>({ kind: "closed" });
  const preview = useAtomCommand(serverEnvironment.previewT3CodeImport);
  const check = useAtomCommand(serverEnvironment.checkT3CodeImport);
  const run = useAtomCommand(serverEnvironment.runT3CodeImport);
  const allowed = useEnvironmentScope(props.environmentId, AuthEnvironmentMaintainScope);
  const [pendingCheck, setPendingCheck] = useState(false);

  const open = async () => {
    setStep({ kind: "loading" });
    const result = await preview({ environmentId: props.environmentId, input: {} });
    if (result._tag !== "Success") {
      if (isAtomCommandInterrupted(result)) return setStep({ kind: "closed" });
      return setStep({ kind: "failed", message: errorMessage(squashAtomCommandFailure(result)) });
    }
    const value = result.value;
    if (value.status === "unavailable") {
      return setStep({ kind: "unavailable", reason: value.reason });
    }
    setStep({ kind: "choose", catalog: value, draft: draftFor(value) });
  };

  const review = async (catalog: Available, draft: Draft) => {
    setPendingCheck(true);
    setStep({ kind: "review", catalog, draft, report: null });
    const result = await check({
      environmentId: props.environmentId,
      input: selectionFrom(catalog, draft),
    });
    setPendingCheck(false);
    if (result._tag === "Success") {
      return setStep({ kind: "review", catalog, draft, report: result.value });
    }
    if (isAtomCommandInterrupted(result)) return setStep({ kind: "choose", catalog, draft });
    toastManager.add({
      type: "error",
      title: t("Could not check the import"),
      description: errorMessage(squashAtomCommandFailure(result)),
    });
    setStep({ kind: "choose", catalog, draft });
  };

  const start = async (catalog: Available, draft: Draft) => {
    setStep({ kind: "running" });
    const result = await run({
      environmentId: props.environmentId,
      input: selectionFrom(catalog, draft),
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: t("Could not import from {app}", { app: OFFICIAL_APP_NAME }),
      description: errorMessage(squashAtomCommandFailure(result)),
    });
    setStep({ kind: "review", catalog, draft, report: null });
  };

  const finish = (result: T3CodeImportResult) => {
    // Client settings live with the client, so the server hands them back instead of writing them.
    if (result.clientSettings !== null) {
      void updateClientSettings(result.clientSettings as never);
    }
    setStep({ kind: "closed" });
  };

  const unavailableText = (reason: Unavailable["reason"]) => {
    switch (reason) {
      case "source-missing":
        return t("No {app} data was found on the computer that runs this environment.", {
          app: OFFICIAL_APP_NAME,
        });
      case "source-is-this-database":
        return t(
          "This environment already uses {app}'s data folder, so there is nothing to import.",
          { app: OFFICIAL_APP_NAME },
        );
      case "source-schema-newer":
        return t(
          "{app}'s data comes from a newer version than this app understands. Update T3 Extend first.",
          { app: OFFICIAL_APP_NAME },
        );
      case "source-schema-diverged":
        return t("{app}'s data has migrations this app does not share. Update T3 Extend first.", {
          app: OFFICIAL_APP_NAME,
        });
    }
  };

  const dialogOpen = step.kind !== "closed" && step.kind !== "loading";
  return (
    <>
      <SettingsRow
        {...(props.searchable
          ? searchableSetting("import-from-t3-code")
          : { title: t("Import from {app}", { app: OFFICIAL_APP_NAME }) })}
        description={t(
          "Choose projects, threads, scheduled tasks and settings from {app} on the computer that runs this environment to bring into T3 Extend. {app}'s own data is only read, never changed.",
          { app: OFFICIAL_APP_NAME },
        )}
        status={
          allowed
            ? props.label === ""
              ? undefined
              : props.label
            : t("Only on the host machine, with maintenance permission")
        }
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!allowed || step.kind === "loading" || step.kind === "running"}
            onClick={() => void open()}
          >
            {step.kind === "loading" ? t("Looking…") : t("Choose…")}
          </Button>
        }
      />
      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next && step.kind !== "running") setStep({ kind: "closed" });
        }}
      >
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("Import from {app}", { app: OFFICIAL_APP_NAME })}</DialogTitle>
            <DialogDescription>
              {step.kind === "review"
                ? t("Review what will happen, then confirm.")
                : step.kind === "running"
                  ? t("{app}'s own data is only read, never changed.", { app: OFFICIAL_APP_NAME })
                  : t(
                      "Pick what to bring over. Threads you already imported are skipped, unless {app} has carried on with them since.",
                      { app: OFFICIAL_APP_NAME },
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
            {step.kind === "choose" && (
              <ChooseStep
                catalog={step.catalog}
                draft={step.draft}
                onChange={(draft) => setStep({ ...step, draft })}
              />
            )}
            {step.kind === "review" &&
              (step.report === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner size="md" />
                  {t("Checking every selected item…")}
                </div>
              ) : (
                <ReviewReport report={step.report} />
              ))}
            {step.kind === "running" && (
              <Progress environmentId={props.environmentId} onFinished={finish} />
            )}
          </DialogPanel>
          {step.kind !== "running" && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep({ kind: "closed" })}>
                {t("Cancel")}
              </Button>
              {step.kind === "choose" && (
                <Button
                  disabled={
                    selectionFrom(step.catalog, step.draft).threadIds.length === 0 &&
                    step.draft.files.size === 0 &&
                    !Array.from(step.draft.tasks.values()).some((task) => task.picked)
                  }
                  onClick={() => void review(step.catalog, step.draft)}
                >
                  {t("Review…")}
                </Button>
              )}
              {step.kind === "review" && (
                <>
                  <Button
                    variant="outline"
                    onClick={() =>
                      setStep({ kind: "choose", catalog: step.catalog, draft: step.draft })
                    }
                  >
                    {t("Back")}
                  </Button>
                  <Button
                    disabled={pendingCheck || step.report === null}
                    onClick={() => void start(step.catalog, step.draft)}
                  >
                    {t("Import")}
                  </Button>
                </>
              )}
            </DialogFooter>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function T3CodeImportSection() {
  const t = useT();
  const { connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.t3CodeImport === true,
  );
  if (supported.length === 0) return null;
  return (
    <SettingsSection
      id="import-from-t3-code"
      title={t("Import from {app}", { app: OFFICIAL_APP_NAME })}
    >
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
