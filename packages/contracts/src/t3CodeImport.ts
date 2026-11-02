import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Why the host's official T3 Code data cannot be imported right now. */
export const T3CodeImportUnavailableReason = Schema.Literals([
  "source-missing",
  "source-is-this-database",
  "source-schema-newer",
  "source-schema-older",
]);
export type T3CodeImportUnavailableReason = typeof T3CodeImportUnavailableReason.Type;

export const T3CodeImportProjectPreview = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  /** Threads this import would add. */
  importableThreads: NonNegativeInt,
  /** Threads this environment already has, from an earlier import. */
  existingThreads: NonNegativeInt,
  /** Threads left out because T3 Code is still working on them. */
  busyThreads: NonNegativeInt,
  /** Set when this environment already has an active project for the same folder: threads join it. */
  joinsProjectId: Schema.NullOr(ProjectId),
});
export type T3CodeImportProjectPreview = typeof T3CodeImportProjectPreview.Type;

export const T3CodeImportPreview = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    sourcePath: Schema.String,
    projects: Schema.Array(T3CodeImportProjectPreview),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: T3CodeImportUnavailableReason,
    sourcePath: Schema.String,
  }),
]);
export type T3CodeImportPreview = typeof T3CodeImportPreview.Type;

export const T3CodeImportInput = Schema.Struct({
  projectIds: Schema.Array(ProjectId).check(Schema.isMinLength(1)),
});
export type T3CodeImportInput = typeof T3CodeImportInput.Type;

export const T3CodeImportResult = Schema.Struct({
  importedProjects: NonNegativeInt,
  importedThreads: NonNegativeInt,
  /** Threads that were already here. */
  existingThreads: NonNegativeInt,
  /** Threads left out because T3 Code is still working on them. */
  busyThreads: NonNegativeInt,
  copiedAttachments: NonNegativeInt,
});
export type T3CodeImportResult = typeof T3CodeImportResult.Type;

export class T3CodeImportError extends Schema.TaggedError<T3CodeImportError>()(
  "T3CodeImportError",
  {
    reason: Schema.Union([
      T3CodeImportUnavailableReason,
      Schema.Literal("project-not-found"),
      Schema.Literal("failed"),
    ]),
    detail: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "source-missing":
        return "No T3 Code data was found on this machine.";
      case "source-is-this-database":
        return "T3 Code's data is this environment's own database.";
      case "source-schema-newer":
        return "T3 Code's data was written by a newer version than this app understands. Update this app first.";
      case "source-schema-older":
        return "T3 Code's data comes from an older version. Open T3 Code once so it updates its data, then import again.";
      case "project-not-found":
        return "A selected project is not in T3 Code's data.";
      case "failed":
        return this.detail ?? "Importing from T3 Code failed.";
    }
  }
}
