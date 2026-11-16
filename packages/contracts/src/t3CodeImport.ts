import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

/** What the app this fork was made from is called; every user-visible mention goes through here. */
export const OFFICIAL_APP_NAME = "T3 Code";

/** Why the host's official T3 Code data cannot be imported right now. */
export const T3CodeImportUnavailableReason = Schema.Literals([
  "source-missing",
  "source-is-this-database",
  "source-schema-newer",
  "source-schema-diverged",
]);
export type T3CodeImportUnavailableReason = typeof T3CodeImportUnavailableReason.Type;

/** Whole files the import can bring over. Provider instances and price overrides live in settings.json but are chosen apart. */
export const T3CodeImportFileKind = Schema.Literals([
  "settings",
  "clientSettings",
  "keybindings",
  "themes",
  "usagePriceOverrides",
  "providerInstances",
]);
export type T3CodeImportFileKind = typeof T3CodeImportFileKind.Type;

/** `updated`: imported before, and the official app has carried on with it since. */
export const T3CodeImportThreadState = Schema.Literals([
  "importable",
  "imported",
  "updated",
  "busy",
]);

export const T3CodeImportThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  updatedAt: Schema.String,
  archived: Schema.Boolean,
  /** Subagent threads that travel with this one. */
  subagentCount: NonNegativeInt,
  state: T3CodeImportThreadState,
  /** Runs started in T3 Extend since the import; importing the thread again would discard them. */
  localChanges: NonNegativeInt,
  worktree: Schema.NullOr(
    Schema.Struct({ path: Schema.String, status: Schema.Literals(["present", "missing"]) }),
  ),
});
export type T3CodeImportThread = typeof T3CodeImportThread.Type;

export const T3CodeImportProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  /** Set when this environment already has an active project for the same folder: threads join it. */
  joinsProjectId: Schema.NullOr(ProjectId),
  /** Top-level threads; subagent threads are counted on their parent. */
  threads: Schema.Array(T3CodeImportThread),
});
export type T3CodeImportProject = typeof T3CodeImportProject.Type;

export const T3CodeImportScheduledTask = Schema.Struct({
  taskId: Schema.String,
  title: Schema.String,
  enabled: Schema.Boolean,
  scheduleKind: Schema.String,
  projectId: ProjectId,
  alreadyImported: Schema.Boolean,
});
export type T3CodeImportScheduledTask = typeof T3CodeImportScheduledTask.Type;

export const T3CodeImportFileOption = Schema.Struct({
  kind: T3CodeImportFileKind,
  available: Schema.Boolean,
});

export const T3CodeImportCatalog = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    sourcePath: Schema.String,
    projects: Schema.Array(T3CodeImportProject),
    scheduledTasks: Schema.Array(T3CodeImportScheduledTask),
    files: Schema.Array(T3CodeImportFileOption),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: T3CodeImportUnavailableReason,
    sourcePath: Schema.String,
  }),
]);
export type T3CodeImportCatalog = typeof T3CodeImportCatalog.Type;

export const T3CodeImportSelection = Schema.Struct({
  /** Top-level threads to bring over. Their parents and, with `includeSubagents`, their subagents come along. */
  threadIds: Schema.Array(ThreadId),
  /** Projects to create even when none of their threads are picked. */
  projectIds: Schema.Array(ProjectId),
  includeSubagents: Schema.Boolean,
  scheduledTasks: Schema.Array(Schema.Struct({ taskId: Schema.String, enabled: Schema.Boolean })),
  files: Schema.Array(T3CodeImportFileKind),
});
export type T3CodeImportSelection = typeof T3CodeImportSelection.Type;

/**
 * One line of the preflight and of the final summary. The client words it from `code`;
 * `subject` names what it is about and `count` is how many things it covers.
 */
export const T3CodeImportNoticeCode = Schema.Literals([
  // fixed automatically
  "project-merged",
  "thread-ids-renewed",
  "parents-pulled-in",
  "checkpoint-refs-copied",
  "limit-recovery-cleared",
  "provider-session-detached",
  "paths-rewritten",
  "attachments-copied",
  "task-imported-active",
  "thread-refreshed",
  // skipped
  "identity-skipped",
  "signing-secrets-skipped",
  "connection-catalog-skipped",
  "desktop-settings-skipped",
  "browser-profile-skipped",
  "browser-storage-skipped",
  "thread-busy",
  "thread-parent-busy",
  "thread-target-busy",
  "thread-target-changed",
  "task-project-missing",
  "task-thread-missing",
  "task-unreadable",
  "setting-rejected",
  "setting-managed",
  "provider-instance-managed",
  "client-setting-rejected",
  "keybinding-rejected",
  "worktree-directories-skipped",
  "relay-state-skipped",
  "provider-instance-exists",
  // imported, needs attention
  "worktree-missing",
  "worktree-shared",
  "provider-files-shared",
  "task-runs-in-both",
  "task-once-passed",
  "task-webhook-url",
  "task-webhook-secret",
  "subagents-omitted",
  "checkpoint-refs-unavailable",
  "checkpoint-refs-conflict",
  "thread-local-discarded",
  "provider-credential-imported",
  "sidebar-settings",
]);
export type T3CodeImportNoticeCode = typeof T3CodeImportNoticeCode.Type;

export const T3CodeImportNotice = Schema.Struct({
  code: T3CodeImportNoticeCode,
  subject: Schema.String,
  detail: Schema.optional(Schema.String),
  count: Schema.optional(NonNegativeInt),
});
export type T3CodeImportNotice = typeof T3CodeImportNotice.Type;

export const T3CodeImportReport = Schema.Struct({
  fixed: Schema.Array(T3CodeImportNotice),
  skipped: Schema.Array(T3CodeImportNotice),
  attention: Schema.Array(T3CodeImportNotice),
});
export type T3CodeImportReport = typeof T3CodeImportReport.Type;

export const T3CodeImportResult = Schema.Struct({
  importedProjects: NonNegativeInt,
  importedThreads: NonNegativeInt,
  /** Selected threads that an earlier import had already brought over. */
  existingThreads: NonNegativeInt,
  importedTasks: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      title: Schema.String,
      enabled: Schema.Boolean,
      /** Where the task's webhook listens on this environment, when it is a webhook task. */
      webhookPath: Schema.NullOr(Schema.String),
    }),
  ),
  /** Applied by the client, which owns client settings. */
  clientSettings: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  report: T3CodeImportReport,
});
export type T3CodeImportResult = typeof T3CodeImportResult.Type;

export const T3CodeImportPhase = Schema.Literals(["preparing", "threads", "files", "tasks"]);

export const T3CodeImportState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({
    status: Schema.Literal("running"),
    phase: T3CodeImportPhase,
    doneThreads: NonNegativeInt,
    totalThreads: NonNegativeInt,
    currentTitle: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("finished"), result: T3CodeImportResult }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
]);
export type T3CodeImportState = typeof T3CodeImportState.Type;

export class T3CodeImportError extends Schema.TaggedError<T3CodeImportError>()(
  "T3CodeImportError",
  {
    reason: Schema.Union([
      T3CodeImportUnavailableReason,
      Schema.Literal("already-running"),
      Schema.Literal("project-not-found"),
      Schema.Literal("failed"),
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "source-missing":
        return `No ${OFFICIAL_APP_NAME} data was found on this machine.`;
      case "source-is-this-database":
        return `${OFFICIAL_APP_NAME}'s data is this environment's own database.`;
      case "source-schema-newer":
        return `${OFFICIAL_APP_NAME}'s data was written by a newer version than this app understands. Update T3 Extend first.`;
      case "source-schema-diverged":
        return `${OFFICIAL_APP_NAME}'s data has migrations this app does not share. Update T3 Extend first.`;
      case "already-running":
        return "An import is already running.";
      case "project-not-found":
        return `A selected project or thread is not in ${OFFICIAL_APP_NAME}'s data.`;
      case "failed":
        return `Importing from ${OFFICIAL_APP_NAME} failed.`;
    }
  }
}
