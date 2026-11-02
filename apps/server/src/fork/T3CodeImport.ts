// fork: bring official T3 Code's projects and threads into this environment's live database.
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import {
  ProjectId,
  T3CodeImportError,
  type T3CodeImportPreview,
  type T3CodeImportProjectPreview,
  type T3CodeImportResult,
  type T3CodeImportUnavailableReason,
  ThreadId,
} from "@t3tools/contracts";
import { officialHomeDirectory } from "@t3tools/shared/forkIdentity";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { BUILD_MIGRATION_HEAD, recordedMigrations } from "../persistence/databaseMigrationHead.ts";
import { migrationManifest } from "../persistence/Migrations.ts";

/**
 * Tables whose rows are the other app's pending work, credentials, or links, or whose rows carry
 * event sequences that mean nothing here. The fork never runs official T3 Code's agents or
 * reaches its other environments, so none of these cross over (same reasoning as migrate-dev-db).
 */
const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "scheduled_tasks",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_command_receipts",
  "orchestration_v2_command_receipts",
  "provider_session_runtime",
  "auth_sessions",
  "auth_pairing_links",
  "peer_environment_links",
  "orchestration_v2_legacy_imports",
  "orchestration_v2_events",
]);

const THREADS_TABLE = "orchestration_v2_projection_threads";
const PROVIDER_SESSIONS_TABLE = "orchestration_v2_projection_provider_sessions";
const PROVIDER_SESSION_BINDINGS_TABLE = "orchestration_v2_projection_provider_session_bindings";
const CONTEXT_TRANSFERS_TABLE = "orchestration_v2_projection_context_transfers";
const SOURCE_ALIAS = "t3code_src";

const RECOVERY_KINDS: ReadonlyArray<ProjectionStore.ProjectionRecoveryKind> = [
  "queued-runs",
  "runtime",
  "subagent-results",
  "delegated-completions",
];

interface SourceThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly rootId: string;
  readonly updatedAt: string;
}

interface SourceProject {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

interface ProjectPlan {
  readonly project: SourceProject;
  /** The active project here for the same folder; the threads join it. */
  readonly joinsProjectId: string | null;
  readonly importable: ReadonlyArray<SourceThread>;
  readonly existingThreads: number;
  readonly busyThreads: number;
}

type SourcePlan =
  | { readonly status: "unavailable"; readonly reason: T3CodeImportUnavailableReason }
  | {
      readonly status: "available";
      readonly sourcePath: string;
      readonly projects: ReadonlyArray<ProjectPlan>;
    };

export class T3CodeImport extends Context.Service<
  T3CodeImport,
  {
    /** What an import would bring over. Reads the source database read-only. */
    readonly preview: Effect.Effect<T3CodeImportPreview, T3CodeImportError>;
    /**
     * Copy the selected projects' threads. Idempotent: ids already here are skipped, so running it
     * again only adds what is new (or what was busy last time).
     */
    readonly run: (input: {
      readonly projectIds: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<T3CodeImportResult, T3CodeImportError>;
  }
>()("t3/fork/T3CodeImport") {}

const isImportError = Schema.is(T3CodeImportError);

const failed = (cause: unknown) =>
  new T3CodeImportError({
    reason: "failed",
    cause,
  });

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const make = Effect.fn("T3CodeImport.make")(function* (options: {
  readonly sourceHome?: string | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
  const importLock = yield* Semaphore.make(1);

  // Only a dev server may be pointed at a copy of the source; installed builds always read ~/.t3.
  const sourceHome = Effect.gen(function* () {
    if (options.sourceHome !== undefined) return path.resolve(options.sourceHome);
    const override =
      config.devUrl === undefined
        ? Option.none<string>()
        : yield* Config.String("T3CODE_IMPORT_SOURCE_HOME").pipe(Config.option);
    return Option.match(override, {
      onSome: (home) => path.resolve(home),
      onNone: () => officialHomeDirectory(NodeOS.homedir(), path.join),
    });
  }).pipe(Effect.mapError(failed));

  const sourcePathOf = (home: string) => path.join(home, "userdata", "statev2.sqlite");

  const sourceUnavailableReason = Effect.fn("T3CodeImport.sourceUnavailableReason")(function* (
    sourcePath: string,
  ) {
    if (!(yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false)))) {
      return "source-missing" as const;
    }
    const canonical = (target: string) =>
      fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
    if ((yield* canonical(sourcePath)) === (yield* canonical(config.dbPath))) {
      return "source-is-this-database" as const;
    }
    const recorded = recordedMigrations(sourcePath);
    if (recorded === null) return "source-missing" as const;
    const known = new Map<number, string>(migrationManifest);
    // A slot this build does not know, or knows under another name, means a newer or diverged build.
    if (recorded.some(({ id, name }) => known.get(id) !== name || id > BUILD_MIGRATION_HEAD)) {
      return "source-schema-newer" as const;
    }
    const recordedIds = new Set(recorded.map(({ id }) => id));
    if (migrationManifest.some(([id]) => !recordedIds.has(id))) {
      return "source-schema-older" as const;
    }
    return undefined;
  });

  const readLiveThreadIds = Effect.fn("T3CodeImport.readLiveThreadIds")(function* () {
    const sourceSql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* Effect.forEach(RECOVERY_KINDS, (kind) =>
      projections.getRecoveryThreadIds(kind),
    );
    // Usage-limit recovery reruns a thread's latest failed run, which would be this app running it.
    const failedOrLimited = yield* sourceSql<{ readonly thread_id: string }>`
      SELECT r.thread_id FROM orchestration_v2_projection_runs r
      WHERE r.status = 'failed' AND r.ordinal = (
        SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = r.thread_id)
      UNION
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.limitRecovery') IS NOT NULL`;
    return new Set<string>([...recovery.flat(), ...failedOrLimited.map((row) => row.thread_id)]);
  });

  const plan = Effect.fn("T3CodeImport.plan")(function* () {
    const home = yield* sourceHome;
    const sourcePath = sourcePathOf(home);
    const reason = yield* sourceUnavailableReason(sourcePath);
    if (reason !== undefined) return { status: "unavailable", reason, sourcePath } as const;

    const existingThreadRows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM ${sql(THREADS_TABLE)}`;
    const existingThreadIds = new Set(existingThreadRows.map((row) => row.thread_id));
    const hereProjects = yield* sql<{
      readonly project_id: string;
      readonly workspace_root: string;
      readonly deleted_at: string | null;
    }>`SELECT project_id, workspace_root, deleted_at FROM projection_projects`;
    const deletedHere = new Set(
      hereProjects.filter((row) => row.deleted_at !== null).map((row) => row.project_id),
    );
    const activeByRoot = new Map(
      hereProjects
        .filter((row) => row.deleted_at === null)
        .map((row) => [row.workspace_root, row.project_id]),
    );

    const { projects, threads, live } = yield* Effect.gen(function* () {
      const sourceSql = yield* SqlClient.SqlClient;
      const projects = yield* sourceSql<{
        readonly project_id: string;
        readonly title: string;
        readonly workspace_root: string;
      }>`SELECT project_id, title, workspace_root FROM projection_projects
         WHERE deleted_at IS NULL ORDER BY updated_at DESC`;
      const threads = yield* sourceSql<{
        readonly thread_id: string;
        readonly project_id: string;
        readonly root_id: string;
        readonly updated_at: string;
        readonly deleted: number;
      }>`SELECT t.thread_id, t.project_id, t.updated_at,
          COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id) AS root_id,
          (t.deleted_at IS NOT NULL OR json_extract(t.payload_json, '$.deletedAt') IS NOT NULL) AS deleted
         FROM ${sourceSql(THREADS_TABLE)} t ORDER BY t.updated_at ASC`;
      return { projects, threads, live: yield* readLiveThreadIds() };
    }).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: sourcePath, readonly: true })),
        ),
      ),
    );

    const deletedRoots = new Set(
      threads.filter((row) => row.deleted === 1).map((row) => row.thread_id),
    );
    const busyFamilies = new Set(
      threads.filter((row) => live.has(row.thread_id)).map((row) => row.root_id),
    );
    const projectPlans = projects.flatMap((row): ReadonlyArray<ProjectPlan> => {
      // A project deleted here after an earlier import stays deleted.
      if (deletedHere.has(row.project_id)) return [];
      const joinsProjectId = activeByRoot.get(row.workspace_root);
      const own = threads.filter(
        (thread) => thread.project_id === row.project_id && !deletedRoots.has(thread.root_id),
      );
      const importable: Array<SourceThread> = [];
      let existingThreads = 0;
      let busyThreads = 0;
      for (const thread of own) {
        if (existingThreadIds.has(thread.thread_id)) existingThreads += 1;
        else if (busyFamilies.has(thread.root_id)) busyThreads += 1;
        else
          importable.push({
            threadId: thread.thread_id,
            projectId: thread.project_id,
            rootId: thread.root_id,
            updatedAt: thread.updated_at,
          });
      }
      return [
        {
          project: {
            projectId: row.project_id,
            title: row.title,
            workspaceRoot: row.workspace_root,
          },
          joinsProjectId: joinsProjectId === row.project_id ? null : (joinsProjectId ?? null),
          importable,
          existingThreads,
          busyThreads,
        },
      ];
    });
    return {
      status: "available",
      sourcePath,
      projects: projectPlans,
    } as const satisfies SourcePlan;
  });

  const preview = plan().pipe(
    Effect.map((result): T3CodeImportPreview => {
      if (result.status === "unavailable") return result;
      return {
        status: "available",
        sourcePath: result.sourcePath,
        projects: result.projects.map((entry): T3CodeImportProjectPreview => ({
          projectId: ProjectId.make(entry.project.projectId),
          title: entry.project.title,
          workspaceRoot: entry.project.workspaceRoot,
          importableThreads: entry.importable.length,
          existingThreads: entry.existingThreads,
          busyThreads: entry.busyThreads,
          joinsProjectId:
            entry.joinsProjectId === null ? null : ProjectId.make(entry.joinsProjectId),
        })),
      };
    }),
    Effect.mapError((cause) => (isImportError(cause) ? cause : failed(cause))),
    Effect.withSpan("T3CodeImport.preview"),
  );

  const columnsOf = Effect.fn("T3CodeImport.columnsOf")(function* (schema: string, table: string) {
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table}, ${schema})`;
    return rows.map((row) => row.name);
  });

  /** Tables holding per-thread rows, minus the ones that must not cross over. */
  const threadTables = Effect.fn("T3CodeImport.threadTables")(function* () {
    const rows = yield* sql<{ readonly name: string }>`
      SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
      WHERE m.type = 'table' AND c.name = 'thread_id'`;
    const references = yield* sql<{ readonly name: string; readonly parent: string }>`
      SELECT m.name, f."table" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) f
      WHERE m.type = 'table'`;
    // A row that points into an excluded table cannot be copied, however far down the chain.
    const excluded = new Set(EXCLUDED_TABLES);
    for (let grew = true; grew;) {
      grew = false;
      for (const { name, parent } of references) {
        if (excluded.has(parent) && !excluded.has(name)) {
          excluded.add(name);
          grew = true;
        }
      }
    }
    const names = rows.map((row) => row.name).filter((name) => !excluded.has(name));
    // Threads first: the message search trigger reads the thread row of each message it indexes.
    const priority = (name: string) =>
      name === THREADS_TABLE ? 0 : name === PROVIDER_SESSIONS_TABLE ? 1 : 2;
    return names.toSorted((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  });

  /** Columns both schemas share, so a column only one side has never breaks the copy. */
  const sharedColumns = Effect.fn("T3CodeImport.sharedColumns")(function* (table: string) {
    const main = yield* columnsOf("main", table);
    const source = yield* columnsOf(SOURCE_ALIAS, table);
    return main.filter((column) => source.includes(column));
  });

  const copyProject = Effect.fn("T3CodeImport.copyProject")(function* (projectId: string) {
    const projectColumns = (yield* sharedColumns("projection_projects")).map(quote).join(", ");
    const eventColumns = (yield* sharedColumns("orchestration_events"))
      .filter((column) => column !== "sequence")
      .map(quote)
      .join(", ");
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO main.projection_projects (${projectColumns})
           SELECT ${projectColumns} FROM ${SOURCE_ALIAS}.projection_projects WHERE project_id = ?`,
          [projectId],
        ).unprepared;
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO main.orchestration_events (${eventColumns})
           SELECT ${eventColumns} FROM ${SOURCE_ALIAS}.orchestration_events
           WHERE aggregate_kind = 'project' AND stream_id = ? ORDER BY sequence ASC`,
          [projectId],
        ).unprepared;
      }),
    );
  });

  const copyThread = Effect.fn("T3CodeImport.copyThread")(function* (input: {
    readonly thread: SourceThread;
    readonly targetProjectId: string;
    readonly tables: ReadonlyArray<{
      readonly name: string;
      readonly columns: ReadonlyArray<string>;
    }>;
    readonly eventColumns: ReadonlyArray<string>;
  }) {
    const { thread, targetProjectId } = input;
    const remap = thread.projectId !== targetProjectId;
    // Only this thread's own rows carry the project id, and event payloads embed it as plain text.
    const text = (column: string) =>
      remap
        ? {
            expression: `replace(${quote(column)}, ?, ?)`,
            params: [thread.projectId, targetProjectId],
          }
        : { expression: quote(column), params: [] };

    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [before] = yield* sql<{ readonly sequence: number | null }>`
          SELECT MAX(sequence) AS sequence FROM orchestration_events
          WHERE application_event_version = 2 AND aggregate_kind = 'thread'`;
        const [cursor] = yield* sql<{ readonly last_sequence: number }>`
          SELECT last_sequence FROM orchestration_v2_projection_metadata
          WHERE projection_name = 'thread-projections'`;

        for (const table of input.tables) {
          const columns = table.columns;
          const select: Array<string> = [];
          const params: Array<unknown> = [];
          for (const column of columns) {
            if (table.name === THREADS_TABLE && column === "project_id") {
              select.push("?");
              params.push(targetProjectId);
            } else if (table.name === THREADS_TABLE && column === "payload_json") {
              const { expression, params: p } = text(column);
              select.push(expression);
              params.push(...p);
            } else {
              select.push(quote(column));
            }
          }
          const where =
            table.name === PROVIDER_SESSIONS_TABLE
              ? `thread_id = ? OR provider_session_id IN (
                   SELECT provider_session_id FROM ${SOURCE_ALIAS}.${quote(PROVIDER_SESSION_BINDINGS_TABLE)}
                   WHERE thread_id = ?)`
              : "thread_id = ?";
          const whereParams =
            table.name === PROVIDER_SESSIONS_TABLE
              ? [thread.threadId, thread.threadId]
              : [thread.threadId];
          yield* sql.unsafe(
            `INSERT OR IGNORE INTO main.${quote(table.name)} (${columns.map(quote).join(", ")})
             SELECT ${select.join(", ")} FROM ${SOURCE_ALIAS}.${quote(table.name)} WHERE ${where}`,
            [...params, ...whereParams],
          ).unprepared;
        }

        const eventSelect: Array<string> = [];
        const eventParams: Array<unknown> = [];
        for (const column of input.eventColumns) {
          if (column === "payload_json" || column === "metadata_json") {
            const { expression, params: p } = text(column);
            eventSelect.push(expression);
            eventParams.push(...p);
          } else {
            eventSelect.push(quote(column));
          }
        }
        // ORDER BY keeps the thread's events in their original order under the new sequences.
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO main.orchestration_events (${input.eventColumns.map(quote).join(", ")})
           SELECT ${eventSelect.join(", ")} FROM ${SOURCE_ALIAS}.orchestration_events
           WHERE aggregate_kind = 'thread' AND stream_id = ? ORDER BY sequence ASC`,
          [...eventParams, thread.threadId],
        ).unprepared;

        // A transfer between two threads is copied by whichever of them lands second.
        const transferColumns = (yield* columnsOf("main", CONTEXT_TRANSFERS_TABLE)).join(", ");
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO main.${quote(CONTEXT_TRANSFERS_TABLE)} (${transferColumns})
           SELECT ${transferColumns} FROM ${SOURCE_ALIAS}.${quote(CONTEXT_TRANSFERS_TABLE)}
           WHERE (source_thread_id = ? AND target_thread_id IN (SELECT thread_id FROM main.${quote(THREADS_TABLE)}))
              OR (target_thread_id = ? AND source_thread_id IN (SELECT thread_id FROM main.${quote(THREADS_TABLE)}))`,
          [thread.threadId, thread.threadId],
        ).unprepared;

        // The new events are already projected by the copied rows; only a caught-up cursor moves.
        if (cursor !== undefined && cursor.last_sequence === (before?.sequence ?? 0)) {
          yield* sql`
            UPDATE orchestration_v2_projection_metadata
            SET last_sequence = (
              SELECT MAX(sequence) FROM orchestration_events
              WHERE application_event_version = 2 AND aggregate_kind = 'thread')
            WHERE projection_name = 'thread-projections'`;
        }
      }),
    );
  });

  /** Tell live subscribers (the sidebar) about what arrived, without replaying whole histories. */
  const announce = Effect.fn("T3CodeImport.announce")(function* (
    threadIds: ReadonlyArray<string>,
    projectIds: ReadonlyArray<string>,
  ) {
    for (const projectId of projectIds) {
      const rows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events
        WHERE aggregate_kind = 'project' AND stream_id = ${projectId} AND event_type = 'project.created'
        ORDER BY sequence ASC LIMIT 1`;
      const sequence = rows[0]?.sequence;
      if (sequence === undefined) continue;
      const events = yield* Stream.runCollect(
        eventStore.readApplicationEvents({
          afterSequence: sequence - 1,
          throughSequence: sequence,
        }),
      );
      yield* eventStore.publishCommitted(Array.from(events));
    }
    for (const threadId of threadIds) {
      const events = yield* Stream.runCollect(
        eventStore.readAgentEvents({
          threadId: ThreadId.make(threadId),
          eventType: "thread.created",
          limit: 1,
        }),
      );
      yield* eventStore.publishCommitted(Array.from(events));
    }
  });

  const copyAttachments = Effect.fn("T3CodeImport.copyAttachments")(function* (
    sourcePath: string,
    threadIds: ReadonlySet<string>,
  ) {
    const sourceDir = path.join(path.dirname(sourcePath), "attachments");
    const names = yield* fs.readDirectory(sourceDir).pipe(Effect.orElseSucceed(() => []));
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    let copied = 0;
    for (const name of names) {
      // Files are named `<threadId>-<attachmentId>...` and thread ids contain dashes themselves.
      const owner = [...name.matchAll(/-/g)].some((dash) =>
        threadIds.has(name.slice(0, dash.index)),
      );
      if (!owner) continue;
      const target = path.join(config.attachmentsDir, name);
      if (yield* fs.exists(target)) continue;
      yield* fs.copyFile(path.join(sourceDir, name), target);
      copied += 1;
    }
    return copied;
  });

  const run: T3CodeImport["Service"]["run"] = (input) =>
    importLock
      .withPermits(1)(
        Effect.gen(function* () {
          const result = yield* plan();
          if (result.status === "unavailable") {
            return yield* new T3CodeImportError({ reason: result.reason });
          }
          const selected = input.projectIds.map((projectId) =>
            result.projects.find((entry) => entry.project.projectId === projectId),
          );
          if (selected.some((entry) => entry === undefined)) {
            return yield* new T3CodeImportError({ reason: "project-not-found" });
          }
          const entries = selected.filter((entry) => entry !== undefined);

          yield* sql`ATTACH DATABASE ${`${NodeURL.pathToFileURL(result.sourcePath).href}?mode=ro`} AS ${sql(SOURCE_ALIAS)}`;
          return yield* Effect.gen(function* () {
            const copyTables = yield* Effect.forEach(yield* threadTables(), (name) =>
              sharedColumns(name).pipe(Effect.map((columns) => ({ name, columns }))),
            );
            const eventColumns = (yield* sharedColumns("orchestration_events")).filter(
              (column) => column !== "sequence",
            );

            const importedThreads: Array<string> = [];
            const createdProjects: Array<string> = [];
            for (const entry of entries) {
              if (entry.importable.length === 0) continue;
              if (entry.joinsProjectId === null) {
                yield* sql<{ readonly project_id: string }>`
                  SELECT project_id FROM projection_projects WHERE project_id = ${entry.project.projectId}`.pipe(
                  Effect.flatMap((rows) =>
                    rows.length > 0
                      ? Effect.void
                      : copyProject(entry.project.projectId).pipe(
                          Effect.tap(() =>
                            Effect.sync(() => createdProjects.push(entry.project.projectId)),
                          ),
                        ),
                  ),
                );
              }
              const targetProjectId = entry.joinsProjectId ?? entry.project.projectId;
              for (const thread of entry.importable) {
                yield* copyThread({ thread, targetProjectId, tables: copyTables, eventColumns });
                importedThreads.push(thread.threadId);
              }
            }

            const copiedAttachments = yield* copyAttachments(
              result.sourcePath,
              new Set(importedThreads),
            ).pipe(Effect.orElseSucceed(() => 0));
            yield* announce(importedThreads, createdProjects).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not announce imported threads to live clients", {
                  cause,
                }),
              ),
            );
            return {
              importedProjects: createdProjects.length,
              importedThreads: importedThreads.length,
              existingThreads: entries.reduce((sum, entry) => sum + entry.existingThreads, 0),
              busyThreads: entries.reduce((sum, entry) => sum + entry.busyThreads, 0),
              copiedAttachments,
            } satisfies T3CodeImportResult;
          }).pipe(Effect.ensuring(sql`DETACH DATABASE ${sql(SOURCE_ALIAS)}`.pipe(Effect.ignore)));
        }),
      )
      .pipe(
        Effect.mapError((cause) => (isImportError(cause) ? cause : failed(cause))),
        Effect.withSpan("T3CodeImport.run"),
      );

  return T3CodeImport.of({ preview, run });
});

export const layer = Layer.effect(T3CodeImport, make({}));

/** Reads another home than ~/.t3; tests point it at fixture databases. */
export const layerWithSourceHome = (sourceHome: string) =>
  Layer.effect(T3CodeImport, make({ sourceHome }));
