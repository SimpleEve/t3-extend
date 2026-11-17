// fork: bring selected parts of official T3 Code's data into this environment while it is running.
import * as NodeOS from "node:os";

import {
  type ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ServerSettingsPatch,
  ClientSettingsPatch,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ScheduledTaskUpsertSchedule,
  isManagedSettingPath,
  T3CodeImportError,
  type T3CodeImportCatalog,
  type T3CodeImportFileKind,
  type T3CodeImportLocalEdit,
  type T3CodeImportNotice,
  type T3CodeImportReport,
  type T3CodeImportResult,
  type T3CodeImportSelection,
  type ProviderSessionId,
  type T3CodeImportState,
  type ThreadId,
  ThreadId as ThreadIdSchema,
  ProjectId as ProjectIdSchema,
} from "@t3tools/contracts";
import { officialHomeDirectory } from "@t3tools/shared/forkIdentity";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { BUILD_MIGRATION_HEAD, recordedMigrations } from "../persistence/databaseMigrationHead.ts";
import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Keybindings from "../keybindings.ts";
import { ensureImportTables, requireLivePolicy } from "./SharedWorktrees.ts";
import {
  clearLimitRecovery,
  detachProviderThread,
  makeRewriter,
  moveTaskIdFields,
  markCheckpointMissing,
  unlinkSubagentChild,
  uuidFromDigest,
  importedProviderInstanceIds,
  pinImportedAntigravityLogin,
} from "./T3CodeImportRewrite.ts";

/**
 * Tables whose rows are the other app's pending work, live sessions, credentials, or links, or whose
 * rows carry event sequences that mean nothing here. The fork never runs official T3 Code's agents or
 * reaches its other environments, so none of these cross over.
 */
const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "scheduled_tasks",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_command_receipts",
  "orchestration_v2_command_receipts",
  "provider_session_runtime",
  "orchestration_v2_projection_provider_sessions",
  "orchestration_v2_projection_provider_session_bindings",
  "auth_sessions",
  "auth_pairing_links",
  "peer_environment_links",
  "orchestration_v2_legacy_imports",
  "orchestration_v2_events",
  // Maintained by triggers on the turn items, so copying them would count each item twice.
  "orchestration_v2_projection_turn_item_counts",
]);

const THREADS_TABLE = "orchestration_v2_projection_threads";
const SESSIONS_TABLE = "orchestration_v2_projection_provider_sessions";
const BINDINGS_TABLE = "orchestration_v2_projection_provider_session_bindings";
/**
 * A replacement copies a thread under the write lock. Measured on synthetic data at the size of the largest real
 * threads (8,032 rows and 6,904 events, about 30 MB), it took 1.2 to 1.6 seconds, roughly 0.1 ms per row or event, so
 * from this many the review warns that other threads pause meanwhile (see FORK.md).
 */
const LARGE_REPLACE_ROWS = 8_000;
/** Holding the write lock longer than this is logged. */
const SLOW_REPLACE_MILLIS = 1_000;
const PROVIDER_THREADS_TABLE = "orchestration_v2_projection_provider_threads";
const CHECKPOINTS_TABLE = "orchestration_v2_projection_checkpoints";
const SCOPES_TABLE = "orchestration_v2_projection_checkpoint_scopes";
const SUBAGENTS_TABLE = "orchestration_v2_projection_subagents";
const TRANSFERS_TABLE = "orchestration_v2_projection_context_transfers";
const REF_PATTERN = /refs\/t3\/orchestration-v2\/checkpoints\/[A-Za-z0-9_-]+\/ordinal\/\d+/g;
const ACTIVE_RUN_STATUSES = "'preparing','starting','running','waiting','queued'";
const ROWS_PER_BATCH = 400;

const RECOVERY_KINDS: ReadonlyArray<ProjectionStore.ProjectionRecoveryKind> = [
  "queued-runs",
  "runtime",
  "subagent-results",
  "delegated-completions",
];

/** Files in the official userdata that are identity or credentials of that install. */
const SIGNING_SECRET =
  /^(server-signing-key|asset-access-signing-key|mcp-oauth-signing-key|secret-request-salt|cloud-.*|dpop-proof-.*)\.bin$/;

type Row = Record<string, unknown>;
const isImportError = Schema.is(T3CodeImportError);
const failed = (cause: unknown) => new T3CodeImportError({ reason: "failed", cause });
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeScheduleJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ScheduledTaskUpsertSchedule),
);

interface SourceThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly parent: string | null;
  readonly relationship: string | null;
  readonly archived: boolean;
  readonly worktree: string | null;
  readonly hasLimitRecovery: boolean;
}

interface ProjectTarget {
  readonly sourceId: string;
  readonly targetId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  /** The target project already exists (an earlier import or the same folder). */
  readonly existing: boolean;
  readonly merged: boolean;
}

interface FilePlan {
  readonly settingsPatch: Record<string, unknown>;
  readonly priceOverrides: unknown;
  readonly providerInstances: ReadonlyArray<{ readonly id: string; readonly config: unknown }>;
  readonly clientSettings: Record<string, unknown> | null;
  readonly keybindings: ReadonlyArray<Record<string, unknown>>;
  readonly themes: ReadonlyArray<string>;
  readonly rewrittenPaths: number;
}

interface Analysis {
  readonly sourcePath: string;
  readonly threads: ReadonlyMap<string, SourceThread>;
  readonly toCopy: ReadonlyArray<SourceThread>;
  readonly alreadyImported: number;
  readonly projects: ReadonlyMap<string, ProjectTarget>;
  readonly threadTargets: ReadonlyMap<string, string>;
  /** Subagents left behind: references to them still get the id they would have if imported later. */
  readonly omittedTargets: ReadonlyMap<string, string>;
  /** Imported threads copied again, with the runs started here that the copy was told it discards. */
  readonly refreshing: ReadonlyMap<
    string,
    { readonly runs: number; readonly edits: ReadonlyArray<T3CodeImportLocalEdit> }
  >;
  /** Subagents left out next to a thread that is copied: their source version is recorded as a baseline. */
  readonly omittedToRecord: ReadonlyArray<{
    readonly sub: SourceThread;
    /** The copied threads it belongs under; its baseline moves only if one of them arrived. */
    readonly owners: ReadonlyArray<string>;
  }>;
  readonly tasks: ReadonlyArray<{
    readonly row: Row;
    readonly enabled: boolean;
    readonly targetProjectId: string;
    readonly targetThreadId: string | null;
  }>;
  readonly files: FilePlan;
  readonly report: T3CodeImportReport;
}

type Compatibility = "equal" | "older" | "newer" | "diverged";

export class T3CodeImport extends Context.Service<
  T3CodeImport,
  {
    /** What the source holds and what can be picked. Reads the source database read-only. */
    readonly preview: Effect.Effect<T3CodeImportCatalog, T3CodeImportError>;
    /** The three groups for a selection: fixed, skipped, needing attention. */
    readonly check: (
      selection: T3CodeImportSelection,
    ) => Effect.Effect<T3CodeImportReport, T3CodeImportError>;
    /** Starts the import in the background; progress arrives through `state`. */
    readonly start: (selection: T3CodeImportSelection) => Effect.Effect<void, T3CodeImportError>;
    readonly state: Stream.Stream<T3CodeImportState>;
    /**
     * Points messages of imported threads at the tasks imported from the same app, for threads and tasks that
     * were imported before copied messages carried the task's new id. Safe to repeat; returns the rows changed.
     */
    readonly relinkTaskMessages: Effect.Effect<number, T3CodeImportError>;
  }
>()("t3/fork/T3CodeImport") {}

/** Import bookkeeping lives in fork-owned tables, never in a numbered migration (see FORK.md). */
const make = Effect.fn("T3CodeImport.make")(function* (options: {
  readonly sourceHome?: string | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digestService = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const keybindings = yield* Keybindings.Keybindings;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const sharedWorktrees = yield* requireLivePolicy();
  // The lock every command and provider event for a thread runs under; a replacement takes it too.
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  // Provider events and effects do not take that lock, so a replacement also looks at the live sessions.
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const scope = yield* Effect.scope;
  const importLock = yield* Semaphore.make(1);
  const stateRef = yield* SubscriptionRef.make<T3CodeImportState>({ status: "idle" });

  yield* ensureImportTables();

  // An earlier build imported Antigravity instances without pinning their sign-in, and the profile
  // they signed in with was never copied. Only an instance a past import recorded is pinned: one
  // made in T3 Extend has no such record, and keeps using the agy CLI's sign-in.
  yield* Effect.gen(function* () {
    const runs = yield* sql<{ readonly summary_json: string | null }>`
      SELECT summary_json FROM fork_t3code_import_runs WHERE summary_json IS NOT NULL`;
    const imported = new Set(runs.flatMap((run) => importedProviderInstanceIds(run.summary_json)));
    if (imported.size === 0) return;
    const { providerInstances } = yield* settingsService.getSettings;
    for (const id of imported) {
      const instance = providerInstances[ProviderInstanceId.make(id)];
      const config = instance?.config as { readonly loginSource?: unknown } | undefined;
      if (instance === undefined || instance.driver !== "antigravity") continue;
      if (config?.loginSource !== undefined) continue;
      yield* settingsService.updateProviderInstance({
        operation: "upsert",
        instanceId: ProviderInstanceId.make(id),
        instance: pinImportedAntigravityLogin(instance) as never,
      });
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not pin imported Antigravity sign-ins.", { cause }),
    ),
  );

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const targetId = Effect.fn("T3CodeImport.targetId")(function* (kind: string, sourceId: string) {
    const digest = yield* digestService
      .digest(Digest.sha256, new TextEncoder().encode(`t3x-import|${kind}|${sourceId}`))
      .pipe(Effect.orDie);
    return uuidFromDigest(digest);
  });

  /** Stable per official task, so messages copied before the task is picked already name it. */
  const taskTargetId = Effect.fn("T3CodeImport.taskTargetId")(function* (sourceId: string) {
    return ScheduledTaskId.make(`scheduled-task:import-${yield* targetId("task", sourceId)}`);
  });

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

  const readJson = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text): unknown => decodeJson(text)),
      Effect.option,
    );
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const compatibility = (sourcePath: string): Compatibility | "unreadable" => {
    const recorded = recordedMigrations(sourcePath);
    if (recorded === null || recorded.length === 0) return "unreadable";
    const known = new Map<number, string>(migrationManifest);
    if (recorded.some(({ id, name }) => known.has(id) && known.get(id) !== name)) return "diverged";
    if (recorded.some(({ id }) => !known.has(id) || id > BUILD_MIGRATION_HEAD)) return "newer";
    const recordedIds = new Set(recorded.map(({ id }) => id));
    return migrationManifest.every(([id]) => recordedIds.has(id)) ? "equal" : "older";
  };

  const locateSource = Effect.fn("T3CodeImport.locateSource")(function* () {
    const home = yield* sourceHome;
    const sourcePath = path.join(home, "userdata", "statev2.sqlite");
    const canonical = (target: string) =>
      fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
    if (!(yield* exists(sourcePath))) return { sourcePath, problem: "source-missing" as const };
    if ((yield* canonical(sourcePath)) === (yield* canonical(config.dbPath))) {
      return { sourcePath, problem: "source-is-this-database" as const };
    }
    const kind = compatibility(sourcePath);
    if (kind === "unreadable") return { sourcePath, problem: "source-missing" as const };
    if (kind === "newer") return { sourcePath, problem: "source-schema-newer" as const };
    if (kind === "diverged") return { sourcePath, problem: "source-schema-diverged" as const };
    return { sourcePath, problem: null, needsMigration: kind === "older" };
  });

  /** Opens the source read-only. `use` receives its client; the main database stays `sql`. */
  const withSource = Effect.fn("T3CodeImport.withSource")(
    function* <A, E, R>(
      _sourcePath: string,
      use: (src: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
    ) {
      const src = yield* SqlClient.SqlClient;
      return yield* use(src);
    },
    (effect, sourcePath) =>
      effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath, readonly: true }))),
  );

  const columnsOf = (client: SqlClient.SqlClient, table: string) =>
    client
      .unsafe<{ readonly name: string }>(`SELECT name FROM pragma_table_info(?)`, [table])
      .pipe(Effect.map((rows) => rows.map((row) => row.name)));

  /**
   * Threads with a run in flight, a pending request, or background work, whichever database `client` is;
   * with `threadId`, only that one.
   */
  const directBusyThreadIds = (client: SqlClient.SqlClient, threadId?: string) => {
    const only = threadId === undefined ? "" : "AND thread_id = ?";
    const params = threadId === undefined ? [] : [threadId, threadId, threadId];
    return client
      .unsafe<{ readonly thread_id: string }>(
        `SELECT thread_id FROM orchestration_v2_projection_runs WHERE status IN (${ACTIVE_RUN_STATUSES}) ${only}
         UNION SELECT thread_id FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending' ${only}
         UNION SELECT thread_id FROM ${PROVIDER_THREADS_TABLE}
           WHERE (status = 'active'
             OR CASE WHEN json_valid(payload_json)
               THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0 ELSE 0 END) ${only}`,
        params,
      )
      .pipe(Effect.map((rows) => rows.map((row) => row.thread_id)));
  };

  /** Whether T3 Extend is working on a thread: a run, a request, background work, or an effect still to run. */
  const targetBlocked = Effect.fn("T3CodeImport.targetBlocked")(function* (threadId: string) {
    if ((yield* directBusyThreadIds(sql, threadId)).length > 0) return true;
    const effects = yield* sql.unsafe<{ readonly effect_id: string }>(
      `SELECT effect_id FROM orchestration_v2_effect_outbox
       WHERE thread_id = ? AND status IN ('pending', 'running') LIMIT 1`,
      [threadId],
    );
    return effects.length > 0;
  });

  /** The provider sessions this copy opened or is bound to, as far as the database knows. */
  const sessionIdsOf = Effect.fn("T3CodeImport.sessionIdsOf")(function* (threadId: string) {
    const rows = yield* sql.unsafe<{ readonly id: string }>(
      `SELECT provider_session_id AS id FROM ${SESSIONS_TABLE} WHERE thread_id = ?1
       UNION SELECT provider_session_id FROM ${BINDINGS_TABLE} WHERE thread_id = ?1
       UNION SELECT provider_session_id FROM orchestration_v2_projection_provider_threads
         WHERE thread_id = ?1 AND provider_session_id IS NOT NULL`,
      [threadId],
    );
    return rows.map((row) => row.id as ProviderSessionId);
  });

  /**
   * Whether a live session in memory still serves only this copy. The database cannot say: rows stay behind
   * as `ready` long after a restart. One that another thread is bound to is a shared host process, which
   * stays up after this thread left it.
   */
  const sessionHeld = Effect.fn("T3CodeImport.sessionHeld")(function* (threadId: string) {
    for (const id of yield* sessionIdsOf(threadId)) {
      if (!(yield* providerSessions.isLive(id))) continue;
      const others = yield* sql.unsafe<{ readonly thread_id: string }>(
        `SELECT thread_id FROM ${BINDINGS_TABLE} WHERE provider_session_id = ? AND thread_id <> ? LIMIT 1`,
        [id, threadId],
      );
      if (others.length === 0) return true;
    }
    return false;
  });

  /**
   * Closes this copy's idle sessions through the manager's own detach, which only drops this thread from a
   * shared process. Returns false when one would not close.
   */
  const closeSessions = Effect.fn("T3CodeImport.closeSessions")(function* (threadId: string) {
    for (const id of yield* sessionIdsOf(threadId)) {
      if (!(yield* providerSessions.isLive(id))) continue;
      const closed = yield* Effect.exit(
        providerSessions.detach({ providerSessionId: id, threadId: threadId as ThreadId }),
      );
      if (Exit.isFailure(closed)) {
        yield* Effect.logWarning("Could not close a provider session before replacing a thread", {
          threadId,
          providerSessionId: id,
          cause: closed.cause,
        });
        return false;
      }
    }
    return true;
  });

  /** Threads the official app is working on or has queued work for. */
  const busyThreadIds = Effect.fn("T3CodeImport.busyThreadIds")(function* (
    sourcePath: string,
    src: SqlClient.SqlClient,
  ) {
    const recovery = yield* Effect.forEach(RECOVERY_KINDS, (kind) =>
      Effect.flatMap(ProjectionStore.ProjectionStoreV2, (store) =>
        store.getRecoveryThreadIds(kind).pipe(Effect.map((ids) => [kind, ids] as const)),
      ),
    ).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provide(NodeSqliteClient.layer({ filename: sourcePath, readonly: true })),
        ),
      ),
    );
    // The official app keeping an idle provider session loaded is not work; this app drops sessions anyway.
    const loaded = yield* src.unsafe<{ readonly thread_id: string }>(
      `SELECT thread_id FROM orchestration_v2_projection_provider_sessions WHERE thread_id IS NOT NULL
       UNION SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings`,
    );
    const loadedIds = new Set(loaded.map((row) => row.thread_id));
    const busy = new Set<string>(yield* directBusyThreadIds(src));
    for (const [kind, ids] of recovery) {
      for (const threadId of ids)
        if (kind !== "runtime" || !loadedIds.has(threadId)) busy.add(threadId);
    }
    return busy;
  });

  const readThreads = Effect.fn("T3CodeImport.readThreads")(function* (src: SqlClient.SqlClient) {
    const rows = yield* src.unsafe<Row>(`SELECT thread_id, project_id, title, updated_at,
        json_extract(payload_json, '$.lineage.parentThreadId') AS parent,
        json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
        json_extract(payload_json, '$.archivedAt') AS archived_at,
        json_extract(payload_json, '$.worktreePath') AS worktree,
        json_extract(payload_json, '$.limitRecovery') IS NOT NULL AS limit_recovery
      FROM ${THREADS_TABLE}
      WHERE deleted_at IS NULL AND json_extract(payload_json, '$.deletedAt') IS NULL`);
    return new Map(
      rows.map((row): [string, SourceThread] => [
        String(row.thread_id),
        {
          id: String(row.thread_id),
          projectId: String(row.project_id),
          title: String(row.title ?? ""),
          updatedAt: String(row.updated_at ?? ""),
          parent: row.parent === null || row.parent === undefined ? null : String(row.parent),
          relationship:
            row.relationship === null || row.relationship === undefined
              ? null
              : String(row.relationship),
          archived: row.archived_at !== null && row.archived_at !== undefined,
          worktree: typeof row.worktree === "string" && row.worktree !== "" ? row.worktree : null,
          hasLimitRecovery: Number(row.limit_recovery) === 1,
        },
      ]),
    );
  });

  interface MappedRow {
    readonly source_id: string;
    readonly target_id: string;
    readonly state: string;
    readonly imported_at: string;
    /** Newest stream version of the official thread when it was copied; null for imports from before it was recorded. */
    readonly source_version: number | null;
    /** Highest run ordinal it had then; null on the same imports. */
    readonly source_runs: number | null;
    /** The thread's user-editable fields at the copy (JSON); null for imports from before it was recorded. */
    readonly source_meta: string | null;
  }

  const mappedTargets = (kind: string) =>
    sql
      .unsafe<MappedRow>(
        `SELECT source_id, target_id, state, imported_at, source_version, source_runs, source_meta FROM fork_t3code_import_map WHERE kind = ?`,
        [kind],
      )
      .pipe(Effect.map((rows) => new Map(rows.map((row) => [row.source_id, row] as const))));

  /**
   * Whether T3 Code carried on with an imported thread since the copy. A copy keeps the events'
   * `stream_version`, so what it holds ends at `source_version` and a newer official stream is an update.
   * Pruning always keeps a stream's newest event, so the version never goes backwards.
   */
  const movedSince = Effect.fn("T3CodeImport.movedSince")(function* (
    src: SqlClient.SqlClient,
    thread: SourceThread,
    row: MappedRow,
  ) {
    const newest =
      (yield* src.unsafe<{ readonly version: number | null }>(
        `SELECT MAX(stream_version) AS version FROM orchestration_events
         WHERE aggregate_kind = 'thread' AND stream_id = ?`,
        [thread.id],
      ))[0]?.version ?? -1;
    // An older import never recorded it; its copied events are the ones dated before the import.
    const copied =
      row.source_version ??
      (yield* sql.unsafe<{ readonly version: number }>(
        `SELECT stream_version AS version FROM orchestration_events
         WHERE aggregate_kind = 'thread' AND stream_id = ? AND occurred_at <= ?
         ORDER BY stream_version DESC LIMIT 1`,
        [row.target_id, row.imported_at],
      ))[0]?.version ??
      -1;
    return newest > copied;
  });

  /**
   * Runs T3 Extend added to an imported copy since the import, counted from their rows: maintenance
   * prunes `run.created` events, so the stream cannot say.
   */
  const localRunsOf = Effect.fn("T3CodeImport.localRunsOf")(function* (row: MappedRow) {
    const counted = yield* row.source_runs === null
      ? sql.unsafe<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ? AND requested_at > ?`,
          [row.target_id, row.imported_at],
        )
      : sql.unsafe<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ? AND ordinal > ?`,
          [row.target_id, row.source_runs],
        );
    return Number(counted[0]?.count ?? 0);
  });

  /**
   * The user-editable fields of a thread row, as one JSON text, so the copy's and today's can be compared.
   * Settling, visits and the like are the app's own bookkeeping and are left out.
   */
  const metaOf = (row: Row): string => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = decodeJson(String(row.payload_json ?? "{}"));
      if (typeof parsed === "object" && parsed !== null)
        payload = parsed as Record<string, unknown>;
    } catch {
      // An unreadable payload compares as empty on both sides.
    }
    return encodeJson({
      title: row.title ?? null,
      pinnedAt: payload.pinnedAt ?? null,
      archivedAt: payload.archivedAt ?? null,
      snoozedUntil: payload.snoozedUntil ?? null,
      settings: [
        row.runtime_mode ?? null,
        row.interaction_mode ?? null,
        payload.modelSelection ?? null,
        payload.autoSettleDisabledAt ?? null,
      ],
    });
  };

  /** What was changed on the copy here since the import, besides runs. An older import has no baseline to compare. */
  /**
   * Whether the copy's title differs from the one imported. The title generator writes titles too and leaves
   * nothing that tells its work from a rename, so this is mentioned but never counted as a loss.
   */
  const titleChangedOf = Effect.fn("T3CodeImport.titleChangedOf")(function* (row: MappedRow) {
    if (row.source_meta === null) return false;
    const now = (yield* sql.unsafe<Row>(`SELECT title FROM ${THREADS_TABLE} WHERE thread_id = ?`, [
      row.target_id,
    ]))[0];
    return (
      now !== undefined &&
      encodeJson((decodeJson(row.source_meta) as Record<string, unknown>).title) !==
        encodeJson(now.title ?? null)
    );
  });
  const localEditsOf = Effect.fn("T3CodeImport.localEditsOf")(function* (row: MappedRow) {
    if (row.source_meta === null) return [] as ReadonlyArray<T3CodeImportLocalEdit>;
    const now = (yield* sql.unsafe<Row>(
      `SELECT title, runtime_mode, interaction_mode, payload_json FROM ${THREADS_TABLE} WHERE thread_id = ?`,
      [row.target_id],
    ))[0];
    if (now === undefined) return [] as ReadonlyArray<T3CodeImportLocalEdit>;
    const was = decodeJson(row.source_meta) as Record<string, unknown>;
    const is = decodeJson(metaOf(now)) as Record<string, unknown>;
    const differs = (key: string) => encodeJson(was[key]) !== encodeJson(is[key]);
    const edits: Array<T3CodeImportLocalEdit> = [];
    if (differs("pinnedAt")) edits.push("pinned");
    if (differs("archivedAt")) edits.push("archived");
    if (differs("snoozedUntil")) edits.push("snoozed");
    if (differs("settings")) edits.push("settings");
    return edits;
  });

  /**
   * An imported thread is stale when its own source moved, or a subagent that was left out of the import
   * did (its baseline was recorded with state 'omitted'), so picking the thread again brings the news.
   */
  const isStale = Effect.fn("T3CodeImport.isStale")(function* (
    src: SqlClient.SqlClient,
    thread: SourceThread,
    row: MappedRow,
    children: ReadonlyMap<string, ReadonlyArray<SourceThread>>,
    done: ReadonlyMap<string, MappedRow>,
  ) {
    if (yield* movedSince(src, thread, row)) return true;
    for (const sub of subagentDescendants(children, thread.id)) {
      const omitted = done.get(sub.id);
      if (omitted?.state === "omitted" && (yield* movedSince(src, sub, omitted))) return true;
    }
    return false;
  });

  /** Where an imported thread stands, counting the subagents that travel with it. */
  const importProgress = Effect.fn("T3CodeImport.importProgress")(function* (
    src: SqlClient.SqlClient,
    members: ReadonlyArray<SourceThread>,
    done: ReadonlyMap<string, MappedRow>,
    children: ReadonlyMap<string, ReadonlyArray<SourceThread>>,
  ) {
    const copied = members.flatMap((member) => {
      const row = done.get(member.id);
      return row?.state === "done" ? [{ member, row }] : [];
    });
    if (copied.length === 0) {
      return { state: "importable" as const, localChanges: 0, localEdits: [] };
    }
    let updated = false;
    let localChanges = 0;
    const localEdits = new Set<T3CodeImportLocalEdit>();
    for (const { member, row } of copied) {
      if (!(yield* isStale(src, member, row, children, done))) continue;
      updated = true;
      localChanges += yield* localRunsOf(row);
      for (const edit of yield* localEditsOf(row)) localEdits.add(edit);
    }
    if (updated) return { state: "updated" as const, localChanges, localEdits: [...localEdits] };
    // A thread whose subagents did not all arrive (an interrupted run) can be picked again to finish.
    return {
      state: copied.length === members.length ? ("imported" as const) : ("importable" as const),
      localChanges: 0,
      localEdits: [],
    };
  });

  const hasNoDescendantsBusy = (
    threads: ReadonlyMap<string, SourceThread>,
    rawBusy: ReadonlySet<string>,
  ) => {
    // A busy subagent makes the thread it belongs to busy.
    const busy = new Set(rawBusy);
    for (const id of rawBusy) {
      let current = threads.get(id);
      while (current !== undefined && current.relationship === "subagent" && current.parent) {
        busy.add(current.parent);
        current = threads.get(current.parent);
      }
    }
    return busy;
  };

  const childrenOf = (threads: ReadonlyMap<string, SourceThread>) => {
    const children = new Map<string, Array<SourceThread>>();
    for (const thread of threads.values()) {
      if (thread.parent === null) continue;
      children.set(thread.parent, [...(children.get(thread.parent) ?? []), thread]);
    }
    return children;
  };

  const subagentDescendants = (
    children: ReadonlyMap<string, ReadonlyArray<SourceThread>>,
    id: string,
  ): ReadonlyArray<SourceThread> =>
    (children.get(id) ?? []).flatMap((child) =>
      child.relationship === "subagent" ? [child, ...subagentDescendants(children, child.id)] : [],
    );

  const isTopLevel = (thread: SourceThread) => thread.relationship !== "subagent";

  const catalogOf = Effect.fn("T3CodeImport.catalog")(function* (
    sourcePath: string,
    src: SqlClient.SqlClient,
  ) {
    const threads = yield* readThreads(src);
    const busy = hasNoDescendantsBusy(threads, yield* busyThreadIds(sourcePath, src));
    const done = yield* mappedTargets("thread");
    const children = childrenOf(threads);
    const progress = new Map<string, Effect.Success<ReturnType<typeof importProgress>>>();
    for (const thread of threads.values()) {
      if (!isTopLevel(thread) || busy.has(thread.id)) continue;
      progress.set(
        thread.id,
        yield* importProgress(
          src,
          [thread, ...subagentDescendants(children, thread.id)],
          done,
          children,
        ),
      );
    }
    const projectRows = yield* src.unsafe<Row>(
      `SELECT project_id, title, workspace_root FROM projection_projects
       WHERE deleted_at IS NULL ORDER BY updated_at DESC`,
    );
    const hereProjects = yield* sql.unsafe<Row>(
      `SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL`,
    );
    const activeByRoot = new Map(
      hereProjects.map((row) => [String(row.workspace_root), String(row.project_id)]),
    );
    const worktreeStatus = new Map<string, "present" | "missing">();
    for (const thread of threads.values()) {
      if (thread.worktree !== null && !worktreeStatus.has(thread.worktree)) {
        worktreeStatus.set(
          thread.worktree,
          (yield* exists(thread.worktree)) ? "present" : "missing",
        );
      }
    }
    const projects = projectRows.map((row) => {
      const root = String(row.workspace_root);
      const joins = activeByRoot.get(root);
      return {
        projectId: ProjectIdSchema.make(String(row.project_id)),
        title: String(row.title),
        workspaceRoot: root,
        joinsProjectId: joins === undefined ? null : ProjectIdSchema.make(joins),
        threads: [...threads.values()]
          .filter((thread) => thread.projectId === String(row.project_id) && isTopLevel(thread))
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((thread) => ({
            threadId: ThreadIdSchema.make(thread.id),
            title: thread.title,
            updatedAt: thread.updatedAt,
            archived: thread.archived,
            subagentCount: subagentDescendants(children, thread.id).length,
            state: progress.get(thread.id)?.state ?? ("busy" as const),
            localChanges: progress.get(thread.id)?.localChanges ?? 0,
            localEdits: progress.get(thread.id)?.localEdits ?? [],
            worktree:
              thread.worktree === null
                ? null
                : {
                    path: thread.worktree,
                    status: worktreeStatus.get(thread.worktree) ?? "missing",
                  },
          })),
      };
    });
    const taskRows = yield* src.unsafe<Row>(
      `SELECT task_id, title, enabled, project_id, json_extract(schedule_json, '$.type') AS kind
       FROM scheduled_tasks ORDER BY created_at ASC`,
    );
    const doneTasks = yield* mappedTargets("task");
    const sourceStateDir = path.dirname(sourcePath);
    const settings = yield* readJson(path.join(sourceStateDir, "settings.json"));
    const settingsRecord =
      Option.isSome(settings) && typeof settings.value === "object" && settings.value !== null
        ? (settings.value as Record<string, unknown>)
        : {};
    const nonEmpty = (value: unknown) =>
      typeof value === "object" && value !== null && Object.keys(value).length > 0;
    const themesDir = path.join(sourceStateDir, "themes");
    const files: Array<{ kind: T3CodeImportFileKind; available: boolean }> = [
      { kind: "settings", available: Option.isSome(settings) },
      {
        kind: "clientSettings",
        available: yield* exists(path.join(sourceStateDir, "client-settings.json")),
      },
      {
        kind: "keybindings",
        available: yield* exists(path.join(sourceStateDir, "keybindings.json")),
      },
      {
        kind: "themes",
        available:
          (yield* fs.readDirectory(themesDir).pipe(Effect.orElseSucceed(() => []))).length > 0,
      },
      { kind: "usagePriceOverrides", available: nonEmpty(settingsRecord.usagePriceOverrides) },
      { kind: "providerInstances", available: nonEmpty(settingsRecord.providerInstances) },
    ];
    return {
      status: "available" as const,
      sourcePath,
      projects,
      scheduledTasks: taskRows.map((row) => ({
        taskId: String(row.task_id),
        title: String(row.title),
        enabled: Number(row.enabled) === 1,
        scheduleKind: String(row.kind ?? "unknown"),
        projectId: ProjectIdSchema.make(String(row.project_id)),
        alreadyImported: doneTasks.get(String(row.task_id))?.state === "done",
      })),
      files,
    } satisfies T3CodeImportCatalog;
  });

  const preview: Effect.Effect<T3CodeImportCatalog, T3CodeImportError> = Effect.gen(function* () {
    const located = yield* locateSource();
    if (located.problem !== null) {
      return {
        status: "unavailable" as const,
        reason: located.problem,
        sourcePath: located.sourcePath,
      };
    }
    return yield* withSource(located.sourcePath, (src) => catalogOf(located.sourcePath, src));
  }).pipe(
    Effect.mapError((cause) => (isImportError(cause) ? cause : failed(cause))),
    Effect.withSpan("T3CodeImport.preview"),
  );

  const planFiles = Effect.fn("T3CodeImport.planFiles")(function* (
    sourceStateDir: string,
    selection: T3CodeImportSelection,
    skipped: Array<T3CodeImportNotice>,
    attention: Array<T3CodeImportNotice>,
  ) {
    const home = path.dirname(sourceStateDir);
    const wants = new Set<T3CodeImportFileKind>(selection.files);
    let rewrittenPaths = 0;
    const toFork = (value: unknown): unknown => {
      const text = encodeJson(value);
      const from = home;
      const matches = text.split(from).length - 1;
      if (matches === 0) return value;
      rewrittenPaths += matches;
      return decodeJson(text.replaceAll(from, config.baseDir));
    };

    const policy = settingsService.managedPolicy;
    const managedBy = policy?.organization ?? "";
    const allowedDrivers = policy?.limits?.providers?.allowedDrivers;
    const settingsPatch: Record<string, unknown> = {};
    let priceOverrides: unknown = undefined;
    const providerInstances: Array<{ id: string; config: unknown }> = [];
    if (
      wants.has("settings") ||
      wants.has("providerInstances") ||
      wants.has("usagePriceOverrides")
    ) {
      const raw = yield* readJson(path.join(sourceStateDir, "settings.json"));
      const record =
        Option.isSome(raw) && typeof raw.value === "object" && raw.value !== null
          ? (raw.value as Record<string, unknown>)
          : {};
      const patchKeys = new Set(
        Object.keys((ServerSettingsPatch as unknown as { fields: object }).fields),
      );
      const decodePatch = Schema.decodeUnknownOption(ServerSettingsPatch);
      for (const [key, value] of Object.entries(record)) {
        if (key === "providerInstances") {
          if (!wants.has("providerInstances")) continue;
          if (isManagedSettingPath(policy, key)) {
            skipped.push({ code: "setting-managed", subject: key, detail: managedBy });
            continue;
          }
          const here = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
          for (const [id, instance] of Object.entries((value ?? {}) as Record<string, unknown>)) {
            if (here !== null && id in here.providerInstances) {
              skipped.push({ code: "provider-instance-exists", subject: id });
              continue;
            }
            const driver = String((instance as { driver?: unknown } | null)?.driver ?? "");
            if (allowedDrivers !== undefined && !allowedDrivers.some((kind) => kind === driver)) {
              skipped.push({ code: "provider-instance-managed", subject: id, detail: managedBy });
              continue;
            }
            providerInstances.push({ id, config: pinImportedAntigravityLogin(toFork(instance)) });
          }
          continue;
        }
        if (key === "usagePriceOverrides") {
          if (!wants.has("usagePriceOverrides")) continue;
          if (isManagedSettingPath(policy, key)) {
            skipped.push({ code: "setting-managed", subject: key, detail: managedBy });
          } else priceOverrides = value;
          continue;
        }
        if (!wants.has("settings")) continue;
        if (key === "previousWorktreesDirectories") {
          // Folders listed here are ones T3 Extend would clean up; it must not take over the official app's.
          skipped.push({ code: "worktree-directories-skipped", subject: key });
          continue;
        }
        if (isManagedSettingPath(policy, key)) {
          skipped.push({ code: "setting-managed", subject: key, detail: managedBy });
          continue;
        }
        if (!patchKeys.has(key) || Option.isNone(decodePatch({ [key]: value }))) {
          skipped.push({ code: "setting-rejected", subject: key });
          continue;
        }
        settingsPatch[key] = toFork(value);
      }
    }

    let clientSettings: Record<string, unknown> | null = null;
    if (wants.has("clientSettings")) {
      const raw = yield* readJson(path.join(sourceStateDir, "client-settings.json"));
      if (Option.isSome(raw) && typeof raw.value === "object" && raw.value !== null) {
        const fields = new Set(
          Object.keys((ClientSettingsPatch as unknown as { fields: object }).fields),
        );
        const decodePatch = Schema.decodeUnknownOption(ClientSettingsPatch);
        const accepted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(raw.value as Record<string, unknown>)) {
          // Upstream removed the legacy sidebar; an older official app may still have it on.
          if (key === "legacySidebarEnabled") {
            if (value === true) attention.push({ code: "sidebar-settings", subject: key });
            continue;
          }
          if (!fields.has(key) || Option.isNone(decodePatch({ [key]: value }))) {
            skipped.push({ code: "client-setting-rejected", subject: key });
          } else accepted[key] = toFork(value);
        }
        clientSettings = accepted;
      }
    }

    const keybindingRules: Array<Record<string, unknown>> = [];
    if (wants.has("keybindings")) {
      const read = (file: string) =>
        readJson(file).pipe(
          Effect.map((value) =>
            Option.isSome(value) && Array.isArray(value.value)
              ? (value.value as Array<Record<string, unknown>>)
              : [],
          ),
        );
      const mine = yield* read(config.keybindingsConfigPath);
      const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
        a.key === b.key && a.command === b.command && (a.when ?? null) === (b.when ?? null);
      for (const rule of yield* read(path.join(sourceStateDir, "keybindings.json"))) {
        if (typeof rule.key !== "string" || typeof rule.command !== "string") {
          skipped.push({ code: "keybinding-rejected", subject: String(rule.command ?? rule.key) });
        } else if (!mine.some((existing) => same(existing, rule))) keybindingRules.push(rule);
      }
    }

    const themes: Array<string> = [];
    if (wants.has("themes")) {
      const names = yield* fs
        .readDirectory(path.join(sourceStateDir, "themes"))
        .pipe(Effect.orElseSucceed(() => []));
      themes.push(...names.filter((name) => name.endsWith(".json")));
    }

    return {
      settingsPatch,
      priceOverrides,
      providerInstances,
      clientSettings,
      keybindings: keybindingRules,
      themes,
      rewrittenPaths,
    } satisfies FilePlan;
  });

  const analyse = Effect.fn("T3CodeImport.analyse")(function* (
    source: { readonly dbPath: string; readonly stateDir: string },
    src: SqlClient.SqlClient,
    selection: T3CodeImportSelection,
  ) {
    const fixed: Array<T3CodeImportNotice> = [];
    const skipped: Array<T3CodeImportNotice> = [];
    const attention: Array<T3CodeImportNotice> = [];
    const sourceStateDir = source.stateDir;

    const threads = yield* readThreads(src);
    const busy = hasNoDescendantsBusy(threads, yield* busyThreadIds(source.dbPath, src));
    const children = childrenOf(threads);
    const doneThreads = yield* mappedTargets("thread");
    const doneProjects = yield* mappedTargets("project");

    // Which threads travel: the picked ones, the parents they depend on, and their subagents.
    const wanted = new Map<string, SourceThread>();
    // What the user asked for by name or through its subagents; a parent pulled in only to hang a fork on stays as it is.
    const explicit = new Set<string>();
    let pulledIn = 0;
    let busySkipped = 0;
    for (const id of selection.threadIds) {
      const picked = threads.get(id);
      if (picked === undefined)
        return yield* new T3CodeImportError({ reason: "project-not-found" });
      if (busy.has(picked.id)) {
        skipped.push({ code: "thread-busy", subject: picked.title });
        busySkipped += 1;
        continue;
      }
      const chain: Array<SourceThread> = [picked];
      let parent = picked.parent === null ? undefined : threads.get(picked.parent);
      while (parent !== undefined && !chain.includes(parent)) {
        chain.push(parent);
        parent = parent.parent === null ? undefined : threads.get(parent.parent);
      }
      if (chain.some((thread) => busy.has(thread.id))) {
        skipped.push({ code: "thread-parent-busy", subject: picked.title });
        continue;
      }
      explicit.add(picked.id);
      for (const thread of chain) {
        if (
          !wanted.has(thread.id) &&
          thread.id !== picked.id &&
          !selection.threadIds.includes(thread.id as ThreadId)
        ) {
          pulledIn += 1;
        }
        wanted.set(thread.id, thread);
      }
    }
    let omittedSubagents = 0;
    const omitted = new Set<string>();
    for (const thread of wanted.values()) {
      for (const sub of subagentDescendants(children, thread.id)) {
        if (selection.includeSubagents) {
          wanted.set(sub.id, sub);
          if (explicit.has(thread.id)) explicit.add(sub.id);
        } else {
          omittedSubagents += 1;
          omitted.add(sub.id);
        }
      }
    }
    if (pulledIn > 0) fixed.push({ code: "parents-pulled-in", subject: "", count: pulledIn });
    if (omittedSubagents > 0) {
      attention.push({ code: "subagents-omitted", subject: "", count: omittedSubagents });
    }
    void busySkipped;

    // An imported thread that T3 Code carried on with is copied again over the one here, under the same id.
    const refreshCandidates = [...explicit].flatMap((id) => {
      const thread = wanted.get(id);
      const row = doneThreads.get(id);
      return thread !== undefined && row?.state === "done" ? [{ thread, row }] : [];
    });
    const refreshing = new Map<
      string,
      { runs: number; edits: ReadonlyArray<T3CodeImportLocalEdit> }
    >();
    for (const { thread, row } of refreshCandidates) {
      if (!(yield* isStale(src, thread, row, children, doneThreads))) continue;
      if (yield* targetBlocked(row.target_id)) {
        skipped.push({ code: "thread-target-busy", subject: thread.title });
        continue;
      }
      const runs = yield* localRunsOf(row);
      const edits = yield* localEditsOf(row);
      refreshing.set(thread.id, { runs, edits });
      if (runs > 0 || edits.length > 0) {
        attention.push({
          code: "thread-local-discarded",
          subject: thread.title,
          detail: edits.join(","),
          count: runs,
        });
      }
      if (yield* titleChangedOf(row)) {
        attention.push({ code: "thread-title-replaced", subject: thread.title });
      }
      // The events and the three tables that hold nearly all of a long thread's rows.
      const size = (yield* src.unsafe<{ readonly count: number }>(
        `SELECT (SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ?1)
              + (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items WHERE thread_id = ?1)
              + (SELECT COUNT(*) FROM orchestration_v2_projection_nodes WHERE thread_id = ?1)
              + (SELECT COUNT(*) FROM orchestration_v2_projection_messages WHERE thread_id = ?1) AS count`,
        [thread.id],
      ))[0]?.count;
      if (Number(size ?? 0) >= LARGE_REPLACE_ROWS) {
        attention.push({ code: "thread-large-replace", subject: thread.title });
      }
    }
    if (refreshing.size > 0) {
      attention.push({ code: "thread-replace-idle", subject: "", count: refreshing.size });
    }
    const alreadyImported = [...wanted.keys()].filter(
      (id) => doneThreads.get(id)?.state === "done" && !refreshing.has(id),
    ).length;
    const toCopy = [...wanted.values()]
      .filter((thread) => doneThreads.get(thread.id)?.state !== "done" || refreshing.has(thread.id))
      .toSorted((a, b) => {
        const depth = (thread: SourceThread) => {
          let count = 0;
          let current = thread;
          while (current.parent !== null && threads.has(current.parent) && count < 100) {
            current = threads.get(current.parent)!;
            count += 1;
          }
          return count;
        };
        return depth(a) - depth(b) || a.updatedAt.localeCompare(b.updatedAt);
      });

    // Projects: the same folder merges into the project already here.
    const projectRows = yield* src.unsafe<Row>(
      `SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL`,
    );
    const hereProjects = yield* sql.unsafe<Row>(
      `SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL`,
    );
    const activeByRoot = new Map(
      hereProjects.map((row) => [String(row.workspace_root), String(row.project_id)]),
    );
    const neededProjects = new Set<string>([
      ...toCopy.map((thread) => thread.projectId),
      ...selection.projectIds,
    ]);
    const projects = new Map<string, ProjectTarget>();
    for (const row of projectRows) {
      const sourceId = String(row.project_id);
      if (!neededProjects.has(sourceId)) continue;
      const root = String(row.workspace_root);
      const mapped = doneProjects.get(sourceId);
      const joined = activeByRoot.get(root);
      const target =
        mapped !== undefined
          ? { id: mapped.target_id, existing: true, merged: false }
          : joined !== undefined
            ? { id: joined, existing: true, merged: true }
            : { id: yield* targetId("project", sourceId), existing: false, merged: false };
      projects.set(sourceId, {
        sourceId,
        targetId: target.id,
        title: String(row.title),
        workspaceRoot: root,
        existing: target.existing,
        merged: target.merged,
      });
      if (target.merged) {
        fixed.push({ code: "project-merged", subject: String(row.title), detail: root });
      }
    }
    const threadTargets = new Map<string, string>();
    // A subagent left out of an earlier import only has a baseline; there is no thread to point at yet.
    for (const [id, row] of doneThreads)
      if (row.state !== "omitted") threadTargets.set(id, row.target_id);
    // A thread copied again keeps the id it already has.
    for (const thread of toCopy) {
      if (!threadTargets.has(thread.id)) {
        threadTargets.set(thread.id, yield* targetId("thread", thread.id));
      }
    }
    const omittedTargets = new Map<string, string>();
    for (const id of omitted) {
      if (!threadTargets.has(id)) omittedTargets.set(id, yield* targetId("thread", id));
    }
    const omittedToRecord = new Map<string, { sub: SourceThread; owners: Array<string> }>();
    for (const thread of toCopy) {
      for (const sub of subagentDescendants(children, thread.id)) {
        const recorded = doneThreads.get(sub.id)?.state;
        if (omitted.has(sub.id) && recorded !== "done" && recorded !== "copying") {
          const entry = omittedToRecord.get(sub.id) ?? { sub, owners: [] };
          entry.owners.push(thread.id);
          omittedToRecord.set(sub.id, entry);
        }
      }
    }
    if (toCopy.length > refreshing.size) {
      fixed.push({
        code: "thread-ids-renewed",
        subject: "",
        count: toCopy.length - refreshing.size,
      });
    }
    if (refreshing.size > 0) {
      fixed.push({ code: "thread-refreshed", subject: "", count: refreshing.size });
    }
    const limitCleared = toCopy.filter((thread) => thread.hasLimitRecovery).length;
    if (limitCleared > 0)
      fixed.push({ code: "limit-recovery-cleared", subject: "", count: limitCleared });

    // Worktrees stay where they are; T3 Extend must never remove one it did not create.
    const worktrees = new Map<string, number>();
    for (const thread of toCopy) {
      if (thread.worktree !== null)
        worktrees.set(thread.worktree, (worktrees.get(thread.worktree) ?? 0) + 1);
    }
    const missing: Array<string> = [];
    for (const worktree of worktrees.keys()) if (!(yield* exists(worktree))) missing.push(worktree);
    if (missing.length > 0) {
      attention.push({
        code: "worktree-missing",
        subject: "",
        count: missing.length,
        detail: missing.slice(0, 3).join(", "),
      });
    }
    if (worktrees.size > 0)
      attention.push({ code: "worktree-shared", subject: "", count: worktrees.size });
    if (toCopy.length > 0)
      attention.push({ code: "provider-files-shared", subject: "", count: toCopy.length });

    // Checkpoints: the same read-only plan the copy follows, so conflicts show before anything is written.
    if (toCopy.length > 0) {
      const planIds = new Map<string, string>([...threadTargets, ...omittedTargets]);
      for (const project of projects.values()) planIds.set(project.sourceId, project.targetId);
      const rewriter = makeRewriter({
        ids: planIds,
        sourceStateDir,
        targetAttachmentsDir: config.attachmentsDir,
        targetBrowserArtifactsDir: config.browserArtifactsDir,
      });
      const plan = yield* planCheckpointRefs({
        src,
        rewrite: rewriter.rewrite,
        threads: toCopy.map((thread) => ({
          thread,
          projectRoot: projectRows.find((p) => String(p.project_id) === thread.projectId)
            ?.workspace_root as string | undefined,
        })),
      });
      if (plan.copied > 0) {
        fixed.push({ code: "checkpoint-refs-copied", subject: "", count: plan.copied });
      }
      if (plan.unavailable.size > 0) {
        attention.push({
          code: "checkpoint-refs-unavailable",
          subject: "",
          count: plan.unavailable.size,
        });
      }
      if (plan.conflicting.size > 0) {
        attention.push({
          code: "checkpoint-refs-conflict",
          subject: "",
          count: plan.conflicting.size,
        });
      }
    }

    // Attachments that belong to these threads.
    const attachmentNames = yield* fs
      .readDirectory(path.join(sourceStateDir, "attachments"))
      .pipe(Effect.orElseSucceed(() => []));
    const attachmentCount = attachmentNames.filter((name) =>
      toCopy.some((thread) => name.startsWith(`${thread.id}-`)),
    ).length;
    if (attachmentCount > 0)
      fixed.push({ code: "attachments-copied", subject: "", count: attachmentCount });

    // Scheduled tasks.
    const tasks: Array<Analysis["tasks"][number]> = [];
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const doneTasks = yield* mappedTargets("task");
    for (const choice of selection.scheduledTasks) {
      if (doneTasks.get(choice.taskId)?.state === "done") continue;
      const rows = yield* src.unsafe<Row>(`SELECT * FROM scheduled_tasks WHERE task_id = ?`, [
        choice.taskId,
      ]);
      const row = rows[0];
      if (row === undefined) {
        skipped.push({ code: "task-unreadable", subject: choice.taskId });
        continue;
      }
      const title = String(row.title);
      const sourceProject = String(row.project_id);
      let targetProject = projects.get(sourceProject)?.targetId;
      if (targetProject === undefined) {
        const rootRow = projectRows.find((p) => String(p.project_id) === sourceProject);
        targetProject =
          doneProjects.get(sourceProject)?.target_id ??
          (rootRow === undefined ? undefined : activeByRoot.get(String(rootRow.workspace_root)));
      }
      if (targetProject === undefined) {
        skipped.push({ code: "task-project-missing", subject: title });
        continue;
      }
      const sourceThread =
        row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id);
      const targetThread = sourceThread === null ? null : (threadTargets.get(sourceThread) ?? null);
      if (sourceThread !== null && targetThread === null) {
        skipped.push({ code: "task-thread-missing", subject: title });
        continue;
      }
      const schedule = Option.getOrNull(decodeScheduleJson(row.schedule_json));
      // A one-time run that is already due would fire the moment the task is saved.
      const oncePassed =
        schedule?.type === "once" &&
        !(DateTime.toEpochMillis(DateTime.makeUnsafe(schedule.runAt)) > nowMillis);
      tasks.push({
        row,
        enabled: choice.enabled && !oncePassed,
        targetProjectId: targetProject,
        targetThreadId: targetThread,
      });
      if (oncePassed) attention.push({ code: "task-once-passed", subject: title });
      else if (choice.enabled) fixed.push({ code: "task-imported-active", subject: title });
      attention.push({ code: "task-runs-in-both", subject: title });
    }
    if (tasks.some((task) => String(task.row.schedule_json).includes('"webhook"'))) {
      skipped.push({ code: "relay-state-skipped", subject: "" });
    }

    const files = yield* planFiles(sourceStateDir, selection, skipped, attention);
    if (files.rewrittenPaths > 0) {
      fixed.push({ code: "paths-rewritten", subject: "", count: files.rewrittenPaths });
    }
    if (files.providerInstances.length > 0) {
      attention.push({
        code: "provider-credential-imported",
        subject: files.providerInstances.map((instance) => instance.id).join(", "),
        count: files.providerInstances.length,
      });
    }

    // What never crosses over: identity, credentials, and state kept in the other app's browser storage.
    const present = (name: string) => exists(path.join(sourceStateDir, name));
    const identity = ["environment-id", "server-owner.sqlite", "anonymous-id", "clerk"];
    const identityPresent: Array<string> = [];
    for (const name of identity) if (yield* present(name)) identityPresent.push(name);
    skipped.push({
      code: "identity-skipped",
      subject: identityPresent.join(", "),
    });
    const secretNames = yield* fs
      .readDirectory(path.join(sourceStateDir, "secrets"))
      .pipe(Effect.orElseSucceed(() => []));
    const signing = secretNames.filter((name) => SIGNING_SECRET.test(name)).length;
    if (signing > 0) skipped.push({ code: "signing-secrets-skipped", subject: "", count: signing });
    if (yield* present("connection-catalog.json"))
      skipped.push({ code: "connection-catalog-skipped", subject: "" });
    if (yield* present("desktop-settings.json"))
      skipped.push({ code: "desktop-settings-skipped", subject: "" });
    if (yield* present("server-browser"))
      skipped.push({ code: "browser-profile-skipped", subject: "" });
    skipped.push({ code: "browser-storage-skipped", subject: "" });

    return {
      sourcePath: source.dbPath,
      threads,
      toCopy,
      alreadyImported,
      projects,
      threadTargets,
      omittedTargets,
      refreshing,
      omittedToRecord: [...omittedToRecord.values()],
      tasks,
      files,
      report: { fixed, skipped, attention },
    } satisfies Analysis;
  });

  const check: T3CodeImport["Service"]["check"] = Effect.fn("T3CodeImport.check")(
    function* (selection) {
      const located = yield* locateSource();
      if (located.problem !== null)
        return yield* new T3CodeImportError({ reason: located.problem });
      // An older source is read as it is here; the run migrates a private copy first.
      const source = { dbPath: located.sourcePath, stateDir: path.dirname(located.sourcePath) };
      const analysis = yield* withSource(located.sourcePath, (src) =>
        analyse(source, src, selection),
      );
      return analysis.report;
    },
    Effect.mapError((cause) => (isImportError(cause) ? cause : failed(cause))),
  );

  /** Tables that hold per-thread rows and may cross over. */
  const threadTables = Effect.fn("T3CodeImport.threadTables")(function* () {
    const rows = yield* sql.unsafe<{ readonly name: string }>(
      `SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
       WHERE m.type = 'table' AND c.name = 'thread_id'`,
    );
    const references = yield* sql.unsafe<{ readonly name: string; readonly parent: string }>(
      `SELECT m.name, f."table" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) f
       WHERE m.type = 'table'`,
    );
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
    return rows
      .map((row) => row.name)
      .filter((name) => !excluded.has(name) && !name.startsWith("fork_"))
      .toSorted(
        (a, b) => Number(b === THREADS_TABLE) - Number(a === THREADS_TABLE) || a.localeCompare(b),
      );
  });

  const sharedColumns = Effect.fn("T3CodeImport.sharedColumns")(function* (
    src: SqlClient.SqlClient,
    table: string,
  ) {
    const mine = yield* columnsOf(sql, table);
    const theirs = new Set(yield* columnsOf(src, table));
    return mine.filter((column) => theirs.has(column));
  });

  const purgeThread = Effect.fn("T3CodeImport.purgeThread")(function* (
    tables: ReadonlyArray<string>,
    targetThreadId: string,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const table of tables) {
          yield* sql.unsafe(`DELETE FROM ${quote(table)} WHERE thread_id = ?`, [targetThreadId]);
        }
        yield* sql.unsafe(
          `DELETE FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ?`,
          [targetThreadId],
        );
        // The copy arrives with no session (its provider thread keeps only the native handle), so a session
        // this thread opened here must not stay around to be reopened. A session another thread is still
        // bound to stays; only this thread's binding goes.
        yield* sql.unsafe(`DELETE FROM ${BINDINGS_TABLE} WHERE thread_id = ?`, [targetThreadId]);
        yield* sql.unsafe(
          `DELETE FROM ${SESSIONS_TABLE} WHERE thread_id = ? AND NOT EXISTS (
             SELECT 1 FROM ${BINDINGS_TABLE} AS other
             WHERE other.provider_session_id = ${SESSIONS_TABLE}.provider_session_id)`,
          [targetThreadId],
        );
        yield* sql.unsafe(`DELETE FROM provider_session_runtime WHERE thread_id = ?`, [
          targetThreadId,
        ]);
      }),
    );
  });

  const insertRows = (
    table: string,
    columns: ReadonlyArray<string>,
    rows: ReadonlyArray<ReadonlyArray<unknown>>,
  ) =>
    Effect.forEach(
      rows,
      (values) =>
        sql.unsafe(
          `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          values as Array<never>,
        ),
      { discard: true },
    );

  interface Counters {
    refsCopied: number;
    refsUnavailable: number;
    refsConflicting: number;
    attachments: number;
    browserArtifacts: number;
    limitCleared: number;
  }

  /**
   * Decides, without writing, what happens to each ready checkpoint's ref: it is created under the
   * name its new scope id gives it, already holds the same commit, or is left alone because its
   * source is gone or the name is taken by another commit. One batched lookup per repository.
   */
  const planCheckpointRefs = Effect.fn("T3CodeImport.planCheckpointRefs")(function* (input: {
    readonly src: SqlClient.SqlClient;
    readonly threads: ReadonlyArray<{
      readonly thread: SourceThread;
      readonly projectRoot: string | undefined;
    }>;
    readonly rewrite: (text: string) => string;
  }) {
    const refMap = new Map<string, string>();
    const unavailable = new Set<string>();
    const conflicting = new Set<string>();
    const create: Array<{ repo: string; newRef: string; sha: string }> = [];
    let same = 0;
    const repoExists = new Map<string, boolean>();
    const exist = Effect.fn("T3CodeImport.repoExists")(function* (candidate: string) {
      const known = repoExists.get(candidate);
      if (known !== undefined) return known;
      const found = yield* exists(candidate);
      repoExists.set(candidate, found);
      return found;
    });
    const byRepo = new Map<string, Array<{ oldRef: string; newRef: string }>>();
    const seen = new Set<string>();
    for (const { thread, projectRoot } of input.threads) {
      const rows = yield* input.src.unsafe<Row>(
        `SELECT c.payload_json AS payload, json_extract(s.payload_json, '$.cwd') AS cwd
         FROM ${CHECKPOINTS_TABLE} c JOIN ${SCOPES_TABLE} s ON s.scope_id = c.scope_id
         WHERE c.thread_id = ? AND c.status = 'ready' AND json_extract(c.payload_json, '$.ref') IS NOT NULL`,
        [thread.id],
      );
      for (const row of rows) {
        const payload = decodeJson(String(row.payload)) as {
          ref?: string | null;
          scopeId: string;
          ordinalWithinScope: number;
        };
        if (typeof payload.ref !== "string" || payload.ref === "" || seen.has(payload.ref))
          continue;
        seen.add(payload.ref);
        const newRef = yield* checkpointRefForScopeOrdinal({
          scopeId: input.rewrite(payload.scopeId) as never,
          ordinalWithinScope: payload.ordinalWithinScope,
        }).pipe(Effect.provideService(Digest.Digest, digestService));
        let repo: string | undefined;
        for (const candidate of [row.cwd, projectRoot]) {
          if (typeof candidate === "string" && (yield* exist(candidate))) {
            repo = candidate;
            break;
          }
        }
        if (repo === undefined) {
          unavailable.add(payload.ref);
          continue;
        }
        byRepo.set(repo, [...(byRepo.get(repo) ?? []), { oldRef: payload.ref, newRef }]);
      }
    }
    for (const [repo, pairs] of byRepo) {
      // Read-only: one lookup for the source refs and the names they would take.
      const checked = yield* git
        .execute({
          operation: "T3CodeImport.checkRefs",
          cwd: repo,
          args: ["cat-file", "--batch-check"],
          stdin: `${[...pairs.map((pair) => pair.oldRef), ...pairs.map((pair) => pair.newRef)].join("\n")}\n`,
          allowNonZeroExit: true,
        })
        .pipe(Effect.mapError(failed));
      const lines = checked.stdout.split("\n");
      const shaAt = (index: number) => {
        const [sha, type] = (lines[index] ?? "").split(" ");
        return type === "missing" || sha === undefined || sha === "" ? null : sha;
      };
      const queued = new Set<string>();
      pairs.forEach((pair, index) => {
        const sha = shaAt(index);
        const existing = shaAt(pairs.length + index);
        if (sha === null || pair.newRef === pair.oldRef) {
          // A name equal to the source's would share the checkpoint with the other app.
          unavailable.add(pair.oldRef);
        } else if (existing === null) {
          refMap.set(pair.oldRef, pair.newRef);
          if (!queued.has(pair.newRef)) {
            queued.add(pair.newRef);
            create.push({ repo, newRef: pair.newRef, sha });
          }
        } else if (existing === sha) {
          refMap.set(pair.oldRef, pair.newRef);
          same += 1;
        } else {
          // Never move a ref that already points somewhere else.
          conflicting.add(pair.oldRef);
        }
      });
    }
    // Refs left out of refMap keep their source text and are marked missing, in rows and events alike.
    const missing = new Set([...unavailable, ...conflicting]);
    return { refMap, unavailable, conflicting, missing, create, copied: create.length + same };
  });

  /** Creates the planned refs for one thread. */
  const copyCheckpointRefs = Effect.fn("T3CodeImport.copyCheckpointRefs")(function* (input: {
    readonly src: SqlClient.SqlClient;
    readonly thread: SourceThread;
    readonly rewrite: (text: string) => string;
    readonly projectRoot: string | undefined;
    readonly counters: Counters;
  }) {
    const plan = yield* planCheckpointRefs({
      src: input.src,
      threads: [{ thread: input.thread, projectRoot: input.projectRoot }],
      rewrite: input.rewrite,
    });
    const byRepo = new Map<string, Array<string>>();
    for (const { repo, newRef, sha } of plan.create) {
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), `create ${newRef} ${sha}`]);
    }
    for (const [repo, commands] of byRepo) {
      yield* git
        .execute({
          operation: "T3CodeImport.copyRefs",
          cwd: repo,
          args: ["update-ref", "--stdin"],
          stdin: `${commands.join("\n")}\n`,
        })
        .pipe(Effect.mapError(failed));
    }
    input.counters.refsCopied += plan.copied;
    input.counters.refsUnavailable += plan.unavailable.size;
    input.counters.refsConflicting += plan.conflicting.size;
    return { refMap: plan.refMap, missing: plan.missing };
  });

  interface RunContext {
    readonly analysis: Analysis;
    readonly src: SqlClient.SqlClient;
    readonly tables: ReadonlyArray<{
      readonly name: string;
      readonly columns: ReadonlyArray<string>;
    }>;
    readonly eventColumns: ReadonlyArray<string>;
    readonly rewrite: (text: string) => string;
    readonly referencedFiles: () => ReadonlyArray<{
      kind: "attachments" | "browser-artifacts";
      name: string;
    }>;
    readonly copiedFiles: Set<string>;
    readonly counters: Counters;
    readonly sourceStateDir: string;
    readonly projectRoots: ReadonlyMap<string, string>;
  }

  const copyReferencedFiles = Effect.fn("T3CodeImport.copyReferencedFiles")(function* (
    context: RunContext,
    extra: ReadonlyArray<{ kind: "attachments" | "browser-artifacts"; name: string }>,
  ) {
    for (const file of [...context.referencedFiles(), ...extra]) {
      const key = `${file.kind}/${file.name}`;
      if (context.copiedFiles.has(key)) continue;
      context.copiedFiles.add(key);
      const targetDir =
        file.kind === "attachments" ? config.attachmentsDir : config.browserArtifactsDir;
      const targetName = file.kind === "attachments" ? context.rewrite(file.name) : file.name;
      const target = path.join(targetDir, targetName);
      yield* fs.makeDirectory(targetDir, { recursive: true });
      if (yield* exists(target)) continue;
      const copied = yield* fs
        .copyFile(path.join(context.sourceStateDir, file.kind, file.name), target)
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (copied) {
        if (file.kind === "attachments") context.counters.attachments += 1;
        else context.counters.browserArtifacts += 1;
      }
    }
  });

  const transformRow = (
    context: RunContext,
    table: string,
    columns: ReadonlyArray<string>,
    row: Row,
    targetProjectId: string,
    refs: { readonly refMap: Map<string, string>; readonly missing: Set<string> },
  ): ReadonlyArray<unknown> => {
    const mapText = (text: string) => {
      const withRefs = text.includes("refs/t3/orchestration-v2/checkpoints")
        ? text.replace(REF_PATTERN, (ref) => refs.refMap.get(ref) ?? ref)
        : text;
      return context.rewrite(withRefs);
    };
    let overrides: Record<string, unknown> = {};
    const payloadSource = typeof row.payload_json === "string" ? row.payload_json : null;
    const child = row.child_thread_id;
    const childLeftOut =
      table === SUBAGENTS_TABLE &&
      typeof child === "string" &&
      !context.analysis.threadTargets.has(child);
    if (childLeftOut) overrides = { child_thread_id: null };
    if (payloadSource !== null) {
      if (childLeftOut) {
        overrides = { ...overrides, payload_json: unlinkSubagentChild(payloadSource) };
      } else if (table === THREADS_TABLE) {
        const cleared = clearLimitRecovery(payloadSource);
        if (cleared.cleared) context.counters.limitCleared += 1;
        overrides = { payload_json: cleared.json, project_id: targetProjectId };
      } else if (table === PROVIDER_THREADS_TABLE) {
        const detached = detachProviderThread(payloadSource);
        overrides = {
          payload_json: detached.json,
          provider_session_id: null,
          ...(detached.status === null ? {} : { status: detached.status }),
        };
      } else if (table === CHECKPOINTS_TABLE) {
        const marked = markCheckpointMissing(payloadSource, refs.missing);
        if (marked !== null) overrides = { payload_json: marked, status: "missing" };
      }
    }
    return columns.map((column) => {
      const value = column in overrides ? overrides[column] : row[column];
      return typeof value === "string" ? mapText(value) : value;
    });
  };

  /**
   * Before any thread row is committed: in memory first (what removals consult), then in the
   * database (what a restart loads). Over-marking is harmless, since these worktrees belong to T3 Code
   * and T3 Extend must never remove them anyway. Idempotent, so a resumed run repeats it safely.
   */
  const markWorktrees = Effect.fn("T3CodeImport.markWorktrees")(function* (
    threads: ReadonlyArray<SourceThread>,
  ) {
    const worktrees = [
      ...new Set(
        threads.flatMap((thread) =>
          thread.worktree === null ? [] : [path.resolve(thread.worktree)],
        ),
      ),
    ];
    if (worktrees.length === 0) return;
    yield* sharedWorktrees.markShared(worktrees);
    const importedAt = yield* nowIso;
    yield* sql.withTransaction(
      Effect.forEach(
        worktrees,
        (worktree) =>
          sql.unsafe(
            `INSERT OR IGNORE INTO fork_t3code_import_map (kind, source_id, target_id, state, detail, imported_at)
             VALUES ('worktree', ?, ?, 'shared', 'created by T3 Code', ?)`,
            [worktree, worktree, importedAt],
          ),
        { discard: true },
      ),
    );
  });

  /**
   * Hand-offs between this thread and another imported one. They have no `thread_id` column, so a purge
   * does not reach them: the ones that tie it to an imported thread are dropped and read again from the
   * source, in the same transaction as the thread. The pair is written by whichever of the two lands second.
   */
  const replaceTransfers = Effect.fn("T3CodeImport.replaceTransfers")(function* (
    context: RunContext,
    thread: SourceThread,
    targetThread: string,
  ) {
    const imported = `SELECT target_id FROM fork_t3code_import_map WHERE kind = 'thread' AND state = 'done' AND target_id <> ?`;
    yield* sql.unsafe(
      `DELETE FROM ${quote(TRANSFERS_TABLE)}
       WHERE (source_thread_id = ? AND target_thread_id IN (${imported}))
          OR (target_thread_id = ? AND source_thread_id IN (${imported}))`,
      [targetThread, targetThread, targetThread, targetThread],
    );
    const done = new Set(
      (yield* sql.unsafe<{ readonly source_id: string }>(
        `SELECT source_id FROM fork_t3code_import_map WHERE kind = 'thread' AND state = 'done'`,
      )).map((row) => row.source_id),
    );
    const columns = yield* sharedColumns(context.src, TRANSFERS_TABLE);
    const rows = (yield* context.src.unsafe<Row>(
      `SELECT * FROM ${quote(TRANSFERS_TABLE)} WHERE source_thread_id = ? OR target_thread_id = ?`,
      [thread.id, thread.id],
    ))
      .filter((row) => {
        const other =
          row.source_thread_id === thread.id ? row.target_thread_id : row.source_thread_id;
        return other !== thread.id && done.has(String(other));
      })
      .map((row) =>
        columns.map((column) =>
          typeof row[column] === "string" ? context.rewrite(String(row[column])) : row[column],
        ),
      );
    yield* insertRows(TRANSFERS_TABLE, columns, rows);
  });

  const copyThread = Effect.fn("T3CodeImport.copyThread")(function* (
    context: RunContext,
    thread: SourceThread,
  ) {
    const { src, analysis } = context;
    const targetThread = analysis.threadTargets.get(thread.id)!;
    const project = analysis.projects.get(thread.projectId);
    const targetProject = project?.targetId ?? thread.projectId;
    const allTables = context.tables.map((table) => table.name);

    // `src` holds one consistent view, so these are exactly where the copy below ends.
    const copiedThrough =
      (yield* src.unsafe<{ readonly version: number | null }>(
        `SELECT MAX(stream_version) AS version FROM orchestration_events
         WHERE aggregate_kind = 'thread' AND stream_id = ?`,
        [thread.id],
      ))[0]?.version ?? -1;
    const copiedRuns =
      (yield* src.unsafe<{ readonly ordinal: number | null }>(
        `SELECT MAX(ordinal) AS ordinal FROM orchestration_v2_projection_runs WHERE thread_id = ?`,
        [thread.id],
      ))[0]?.ordinal ?? 0;
    const copiedMeta = metaOf(
      (yield* src.unsafe<Row>(
        `SELECT title, runtime_mode, interaction_mode, payload_json FROM ${THREADS_TABLE} WHERE thread_id = ?`,
        [thread.id],
      ))[0] ?? {},
    );
    const importedAt = yield* nowIso;
    const countersBefore = { ...context.counters };
    // Refs are only ever created, so this is safe to do before the replacement is decided.
    const refs = yield* copyCheckpointRefs({
      src,
      thread,
      rewrite: context.rewrite,
      projectRoot: context.projectRoots.get(thread.projectId),
      counters: context.counters,
    });

    const previous = (yield* sql.unsafe<MappedRow>(
      `SELECT source_id, target_id, state, imported_at, source_version, source_runs, source_meta
       FROM fork_t3code_import_map WHERE kind = 'thread' AND source_id = ?`,
      [thread.id],
    ))[0];
    const eventColumns = context.eventColumns;
    const write = Effect.gen(function* () {
      // A run that stopped halfway left a partial copy, and a finished one is being replaced: start over.
      if (previous?.state === "done" || previous?.state === "copying") {
        yield* purgeThread(allTables, targetThread);
      }
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO fork_t3code_import_map (kind, source_id, target_id, state, detail, imported_at, source_version, source_runs, source_meta)
         VALUES ('thread', ?, ?, 'copying', ?, ?, ?, ?, ?)`,
        [
          thread.id,
          targetThread,
          thread.worktree,
          importedAt,
          copiedThrough,
          copiedRuns,
          copiedMeta,
        ],
      );

      for (const table of context.tables) {
        let last = -1;
        for (;;) {
          const batch = yield* src.unsafe<Row>(
            `SELECT rowid AS "__rowid", * FROM ${quote(table.name)} WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
            [thread.id, last, ROWS_PER_BATCH],
          );
          if (batch.length === 0) break;
          last = Number(batch[batch.length - 1]!["__rowid"]);
          const values = batch.map((row) =>
            transformRow(context, table.name, table.columns, row, targetProject, refs),
          );
          yield* sql.withTransaction(insertRows(table.name, table.columns, values));
        }
      }

      let lastSequence = -1;
      for (;;) {
        const batch = yield* src.unsafe<Row>(
          `SELECT * FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ? AND sequence > ?
           ORDER BY sequence LIMIT ?`,
          [thread.id, lastSequence, ROWS_PER_BATCH],
        );
        if (batch.length === 0) break;
        lastSequence = Number(batch[batch.length - 1]!["sequence"]);
        const values = batch.map((row) => {
          // Rebuilding projections from these events must give the same checkpoint state the rows have.
          const marked =
            row.event_type === "checkpoint.captured" && typeof row.payload_json === "string"
              ? markCheckpointMissing(row.payload_json, refs.missing)
              : null;
          return eventColumns.map((column) => {
            const value = column === "payload_json" && marked !== null ? marked : row[column];
            if (typeof value !== "string") return value;
            const withRefs = value.includes("refs/t3/orchestration-v2/checkpoints")
              ? value.replace(REF_PATTERN, (ref) => refs.refMap.get(ref) ?? ref)
              : value;
            return context.rewrite(withRefs);
          });
        });
        yield* sql.withTransaction(insertRows("orchestration_events", eventColumns, values));
      }

      yield* replaceTransfers(context, thread, targetThread);

      // The copied rows already hold what the new events say, so a caught-up projection cursor moves with them.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const cursor = (yield* sql.unsafe<{ readonly last_sequence: number }>(
            `SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'`,
          ))[0];
          const newest = (yield* sql.unsafe<{ readonly sequence: number | null }>(
            `SELECT MAX(sequence) AS sequence FROM orchestration_events
             WHERE application_event_version = 2 AND aggregate_kind = 'thread'`,
          ))[0]?.sequence;
          yield* sql.unsafe(
            `UPDATE fork_t3code_import_map SET state = 'done' WHERE kind = 'thread' AND source_id = ?`,
            [thread.id],
          );
          // Rows from before this import were already projected; only move a cursor that was current.
          // A thread copied again had its old events inside the cursor, so a cursor past the rest is current too.
          if (cursor !== undefined && newest !== null && newest !== undefined) {
            const before = (yield* sql.unsafe<{ readonly sequence: number | null }>(
              `SELECT MAX(sequence) AS sequence FROM orchestration_events
               WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id <> ?`,
              [targetThread],
            ))[0]?.sequence;
            if (cursor.last_sequence >= (before ?? 0)) {
              yield* sql.unsafe(
                `UPDATE orchestration_v2_projection_metadata SET last_sequence = ? WHERE projection_name = 'thread-projections'`,
                [newest],
              );
            }
          }
        }),
      );
      return "copied" as const;
    });

    // Under the thread's command lock, which provider events and effects do not take: so the copy must also
    // have no live session, work or effect, checked again in the write transaction. A failure keeps the old copy.
    const outcome =
      previous?.state === "done" || previous?.state === "copying"
        ? yield* Effect.gen(function* () {
            const waitedFrom = DateTime.toEpochMillis(yield* DateTime.now);
            return yield* threadCommands.withLock(
              targetThread as ThreadId,
              Effect.gen(function* () {
                const heldFrom = DateTime.toEpochMillis(yield* DateTime.now);
                // An idle session is closed first, but never one of a thread that is working.
                if (yield* targetBlocked(targetThread)) return "busy" as const;
                if (!(yield* closeSessions(targetThread))) return "session" as const;
                const result = yield* sql.withTransaction(
                  Effect.gen(function* () {
                    if (yield* targetBlocked(targetThread)) return "busy" as const;
                    if (yield* sessionHeld(targetThread)) return "session" as const;
                    // A half-built copy has nothing the review could have named; for a finished one, what the
                    // review told the user goes, and more than that was not agreed to.
                    if (previous.state === "done") {
                      const agreed = analysis.refreshing.get(thread.id);
                      const edits = yield* localEditsOf(previous);
                      if (
                        (yield* localRunsOf(previous)) > (agreed?.runs ?? 0) ||
                        edits.some((edit) => !(agreed?.edits ?? []).includes(edit))
                      ) {
                        return "changed" as const;
                      }
                    }
                    return yield* write;
                  }),
                );
                const heldMillis = DateTime.toEpochMillis(yield* DateTime.now) - heldFrom;
                const waitedMillis = heldFrom - waitedFrom;
                const detail = { thread: thread.id, outcome: result, heldMillis, waitedMillis };
                yield* heldMillis >= SLOW_REPLACE_MILLIS
                  ? Effect.logWarning(
                      "T3 Code import held the write lock for a long time while replacing a thread",
                      detail,
                    )
                  : Effect.logDebug("T3 Code import replaced a thread", detail);
                return result;
              }),
            );
          })
        : yield* write;
    if (outcome !== "copied") {
      Object.assign(context.counters, countersBefore);
      return outcome;
    }

    // Attachments are named after their thread; browser artifacts are found through the paths rows hold.
    const attachmentNames = yield* fs
      .readDirectory(path.join(context.sourceStateDir, "attachments"))
      .pipe(Effect.orElseSucceed(() => []));
    yield* copyReferencedFiles(
      context,
      attachmentNames
        .filter((name) => name.startsWith(`${thread.id}-`))
        .map((name) => ({ kind: "attachments" as const, name })),
    );

    // Tell open clients the thread exists, without replaying its whole history.
    yield* eventStore
      .readAgentEvents({
        threadId: targetThread as ThreadId,
        eventType: "thread.created",
        limit: 1,
      })
      .pipe(
        Stream.runCollect,
        Effect.flatMap((events) => eventStore.publishCommitted(Array.from(events))),
        Effect.catch((cause) =>
          Effect.logWarning("Could not announce an imported thread to live clients", { cause }),
        ),
      );
    return "copied" as const;
  });

  const copyProject = Effect.fn("T3CodeImport.copyProject")(function* (
    context: RunContext,
    project: ProjectTarget,
  ) {
    const columns = yield* sharedColumns(context.src, "projection_projects");
    const eventColumns = context.eventColumns;
    const rows = yield* context.src.unsafe<Row>(
      `SELECT * FROM projection_projects WHERE project_id = ?`,
      [project.sourceId],
    );
    const events = yield* context.src.unsafe<Row>(
      `SELECT * FROM orchestration_events WHERE aggregate_kind = 'project' AND stream_id = ? ORDER BY sequence`,
      [project.sourceId],
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* insertRows(
          "projection_projects",
          columns,
          rows.map((row) =>
            columns.map((column) => {
              const value = row[column];
              return typeof value === "string" ? context.rewrite(value) : value;
            }),
          ),
        );
        yield* insertRows(
          "orchestration_events",
          eventColumns,
          events.map((row) =>
            eventColumns.map((column) => {
              const value = row[column];
              return typeof value === "string" ? context.rewrite(value) : value;
            }),
          ),
        );
        yield* sql.unsafe(
          `INSERT OR REPLACE INTO fork_t3code_import_map (kind, source_id, target_id, state, detail, imported_at)
           VALUES ('project', ?, ?, 'done', ?, ?)`,
          [project.sourceId, project.targetId, project.workspaceRoot, yield* nowIso],
        );
      }),
    );
    // Any project event makes open clients load the whole project, and compaction can leave
    // the source without its creation event. Clients skip events behind their cursor, so
    // this must be announced now: a later resume will not replay it.
    const latest = yield* sql.unsafe<{ readonly sequence: number }>(
      `SELECT sequence FROM orchestration_events
       WHERE aggregate_kind = 'project' AND stream_id = ?
       ORDER BY sequence DESC LIMIT 1`,
      [project.targetId],
    );
    const sequence = latest[0]?.sequence;
    if (sequence !== undefined) {
      yield* eventStore
        .readApplicationEvents({ afterSequence: sequence - 1, throughSequence: sequence })
        .pipe(
          Stream.runCollect,
          Effect.flatMap((events) => eventStore.publishCommitted(Array.from(events))),
          Effect.catch((cause) =>
            Effect.logWarning("Could not announce an imported project to live clients", { cause }),
          ),
        );
    }
  });

  const importScheduledTasks = Effect.fn("T3CodeImport.importScheduledTasks")(function* (
    analysis: Analysis,
  ) {
    const imported: Array<T3CodeImportResult["importedTasks"][number]> = [];
    const unreadable: Array<T3CodeImportNotice> = [];
    const secretNotices: Array<T3CodeImportNotice> = [];
    for (const task of analysis.tasks) {
      const row = task.row;
      const sourceId = String(row.task_id);
      const id = yield* taskTargetId(sourceId);
      const decode = <A>(schema: Schema.Decoder<A>, json: unknown) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(json);
      let signingSecret: string | null = null;
      const saved = yield* Effect.gen(function* () {
        const schedule = yield* decode(ScheduledTaskUpsertSchedule, row.schedule_json);
        const workspaceStrategy = yield* decode(
          OrchestrationV2ThreadLaunchWorkspaceStrategy,
          row.workspace_strategy_json,
        );
        const modelSelection = yield* decode(ModelSelection, row.model_selection_json);
        // The official secret is not carried over: the URL changes anyway, so the sender is updated either way.
        if (schedule.type === "webhook" && schedule.signature != null) {
          signingSecret = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
        }
        return yield* scheduledTasks.upsert({
          id,
          title: String(row.title) as never,
          prompt: String(row.prompt) as never,
          enabled: task.enabled,
          schedule:
            schedule.type === "webhook" && schedule.signature != null && signingSecret !== null
              ? { ...schedule, signature: { ...schedule.signature, secret: signingSecret } }
              : schedule,
          projectId: task.targetProjectId as ProjectId,
          threadId: task.targetThreadId as ThreadId | null,
          workspaceStrategy,
          modelSelection,
          runtimeMode: row.runtime_mode as never,
          interactionMode: row.interaction_mode as never,
        });
      }).pipe(Effect.option);
      if (Option.isNone(saved)) {
        unreadable.push({ code: "task-unreadable", subject: String(row.title) });
        continue;
      }
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO fork_t3code_import_map (kind, source_id, target_id, state, detail, imported_at)
         VALUES ('task', ?, ?, 'done', NULL, ?)`,
        [sourceId, id, yield* nowIso],
      );
      imported.push({
        taskId: id,
        title: String(row.title),
        enabled: task.enabled,
        webhookPath: saved.value.task.webhook?.path ?? null,
      });
      if (signingSecret !== null) {
        secretNotices.push({
          code: "task-webhook-secret",
          subject: String(row.title),
          detail: signingSecret,
        });
      }
    }
    return { imported, unreadable, secretNotices };
  });

  /** Tables whose rows hold messages as JSON, and the column that says which thread a row belongs to. */
  const TASK_LINK_TABLES = [
    { table: "orchestration_v2_projection_messages", thread: "thread_id", where: "" },
    { table: "orchestration_v2_projection_turn_items", thread: "thread_id", where: "" },
    { table: "orchestration_events", thread: "stream_id", where: "aggregate_kind = 'thread' AND " },
    { table: "orchestration_v2_events", thread: "thread_id", where: "" },
  ] as const;

  /**
   * Moves the official task id in imported messages to the imported task's id, a thread at a time under the
   * thread's command lock, so a command that read the old id cannot write it back after the move. The task is
   * marked linked only once every thread is done; until then it stays pending and the next call finishes it.
   */
  const relinkPendingTasks = Effect.fn("T3CodeImport.relinkPendingTasks")(function* () {
    const pending = yield* sql.unsafe<{ readonly source_id: string; readonly target_id: string }>(
      `SELECT source_id, target_id FROM fork_t3code_import_map AS task
       WHERE kind = 'task' AND state = 'done' AND NOT EXISTS (
         SELECT 1 FROM fork_t3code_import_map AS link WHERE link.kind = 'task-links' AND link.source_id = task.source_id)`,
    );
    if (pending.length === 0) return 0;
    const taskIds = new Map(pending.map((task) => [task.source_id, task.target_id] as const));
    const mentions = pending.map(() => "instr(payload_json, ?) > 0").join(" OR ");
    const sourceIds = pending.map((task) => task.source_id);

    const tables: Array<(typeof TASK_LINK_TABLES)[number]> = [];
    for (const entry of TASK_LINK_TABLES) {
      const columns = yield* sql.unsafe<{ readonly name: string }>(
        `SELECT name FROM pragma_table_info('${entry.table}')`,
      );
      const names = new Set(columns.map((column) => column.name));
      if (names.has("payload_json") && names.has(entry.thread)) tables.push(entry);
    }
    const threads = new Set<string>();
    for (const { table, thread, where } of tables) {
      const rows = yield* sql.unsafe<{ readonly id: string }>(
        `SELECT DISTINCT ${thread} AS id FROM ${table} WHERE ${where}(${mentions})`,
        sourceIds,
      );
      for (const row of rows) threads.add(String(row.id));
    }

    let changed = 0;
    // A fixed order, so two callers never hold one thread's lock while waiting for another's.
    for (const threadId of [...threads].toSorted()) {
      changed += yield* threadCommands.withLock(
        threadId as ThreadId,
        sql.withTransaction(
          Effect.gen(function* () {
            let moved = 0;
            for (const { table, thread, where } of tables) {
              const rows = yield* sql.unsafe<{
                readonly rid: number;
                readonly payload_json: string;
              }>(
                `SELECT rowid AS rid, payload_json FROM ${table} WHERE ${where}${thread} = ? AND (${mentions})`,
                [threadId, ...sourceIds],
              );
              for (const row of rows) {
                const json = moveTaskIdFields(String(row.payload_json), taskIds);
                if (json === null) continue;
                yield* sql.unsafe(`UPDATE ${table} SET payload_json = ? WHERE rowid = ?`, [
                  json,
                  row.rid,
                ]);
                moved += 1;
              }
            }
            return moved;
          }),
        ),
      );
    }

    const at = yield* nowIso;
    yield* sql.withTransaction(
      Effect.forEach(
        pending,
        (task) =>
          sql.unsafe(
            `INSERT OR REPLACE INTO fork_t3code_import_map (kind, source_id, target_id, state, detail, imported_at)
             VALUES ('task-links', ?, ?, 'done', NULL, ?)`,
            [task.source_id, task.target_id, at],
          ),
        { discard: true },
      ),
    );
    return changed;
  });

  /** The driver already waits out a busy database; two more tries cover a lock lost in between, and what still fails stays pending. */
  const relinkWithRetry = relinkPendingTasks().pipe(Effect.retry({ times: 2 }));
  const relinkTaskMessages: T3CodeImport["Service"]["relinkTaskMessages"] = importLock
    .withPermits(1)(relinkWithRetry)
    .pipe(Effect.mapError(failed));
  const relinkQuietly = relinkWithRetry.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not relink imported task messages; they stay pending", { cause }),
    ),
  );
  const relinkInBackground = importLock
    .withPermits(1)(relinkQuietly)
    .pipe(Effect.forkIn(scope), Effect.asVoid);

  const importFiles = Effect.fn("T3CodeImport.importFiles")(function* (
    analysis: Analysis,
    sourceStateDir: string,
    attention: Array<T3CodeImportNotice>,
  ) {
    const { files } = analysis;
    const patch: Record<string, unknown> = { ...files.settingsPatch };
    if (files.priceOverrides !== undefined) patch.usagePriceOverrides = files.priceOverrides;
    if (Object.keys(patch).length > 0) {
      yield* settingsService.updateSettings(patch as never);
    }
    for (const instance of files.providerInstances) {
      yield* settingsService.updateProviderInstance({
        operation: "create",
        instanceId: ProviderInstanceId.make(instance.id),
        instance: instance.config as never,
      });
      // The credential belongs to its provider instance and travels only with it.
      const driver = String((instance.config as { driver?: unknown }).driver ?? "");
      for (const namespace of [driver, "codex-chatgpt", "codex-chatgpt-registration"]) {
        const digest = yield* digestService
          .digest(
            Digest.sha256,
            new TextEncoder().encode(`${namespace.length}:${namespace}${instance.id}`),
          )
          .pipe(Effect.orDie);
        const key = `provider-auth-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        const file = path.join(sourceStateDir, "secrets", `${key}.bin`);
        if (!(yield* exists(file))) continue;
        if (Option.isSome(yield* secrets.get(key).pipe(Effect.orElseSucceed(() => Option.none()))))
          continue;
        yield* secrets.set(key, yield* fs.readFile(file));
      }
    }
    for (const rule of files.keybindings) {
      yield* keybindings
        .upsertKeybindingRule({
          key: rule.key as string,
          command: rule.command as never,
          ...(typeof rule.when === "string" ? { when: rule.when } : {}),
        } as never)
        .pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              attention.push({ code: "keybinding-rejected", subject: String(rule.command) });
            }),
          ),
        );
    }
    if (files.themes.length > 0) {
      yield* fs.makeDirectory(config.environmentThemesDir, { recursive: true });
      for (const name of files.themes) {
        const target = path.join(config.environmentThemesDir, name);
        if (!(yield* exists(target))) {
          yield* fs.copyFile(path.join(sourceStateDir, "themes", name), target);
        }
      }
    }
  });

  /** One pass over the rows of `table` that match `where`, in batches, into `dst` under the columns both share. */
  const transfer = Effect.fn("T3CodeImport.transfer")(function* (input: {
    readonly src: SqlClient.SqlClient;
    readonly dst: SqlClient.SqlClient;
    readonly table: string;
    readonly where: string;
    readonly params: ReadonlyArray<unknown>;
  }) {
    const theirs = new Set(yield* columnsOf(input.dst, input.table));
    const columns = (yield* columnsOf(input.src, input.table)).filter((name) => theirs.has(name));
    if (columns.length === 0) return;
    let last = -1;
    for (;;) {
      const batch = yield* input.src.unsafe<Row>(
        `SELECT rowid AS "__rowid", * FROM ${quote(input.table)} WHERE ${input.where} AND rowid > ? ORDER BY rowid LIMIT ?`,
        [...input.params, last, ROWS_PER_BATCH] as Array<never>,
      );
      if (batch.length === 0) return;
      last = Number(batch[batch.length - 1]!["__rowid"]);
      yield* input.dst.withTransaction(
        Effect.forEach(
          batch,
          (row) =>
            input.dst.unsafe(
              `INSERT OR IGNORE INTO ${quote(input.table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
              columns.map((column) => row[column]) as Array<never>,
            ),
          { discard: true },
        ),
      );
    }
  });

  /**
   * An older source is not copied whole (the real one is gigabytes). A new file gets the source's own
   * schema by running the migrator up to the version the source was at, then only the picked rows,
   * and the migrator carries it up to this build, so every later migration reaches those rows too.
   */
  const stageSelection = Effect.fn("T3CodeImport.stageSelection")(function* (input: {
    readonly src: SqlClient.SqlClient;
    readonly stagingPath: string;
    readonly sourceVersion: number;
    readonly threadIds: ReadonlyArray<string>;
    readonly projectIds: ReadonlyArray<string>;
  }) {
    const staging = NodeSqliteClient.layer({ filename: input.stagingPath });
    yield* runMigrations({ toMigrationInclusive: input.sourceVersion }).pipe(
      Effect.provide(staging),
    );
    const tables = new Set(yield* threadTables());
    yield* Effect.gen(function* () {
      const dst = yield* SqlClient.SqlClient;
      const present = new Set(
        (yield* input.src.unsafe<{ readonly name: string }>(
          `SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
           WHERE m.type = 'table' AND c.name = 'thread_id'`,
        )).map((row) => row.name),
      );
      yield* transfer({
        src: input.src,
        dst,
        table: "projection_projects",
        where: "1 = 1",
        params: [],
      });
      yield* transfer({
        src: input.src,
        dst,
        table: "scheduled_tasks",
        where: "1 = 1",
        params: [],
      });
      for (const projectId of input.projectIds) {
        yield* transfer({
          src: input.src,
          dst,
          table: "orchestration_events",
          where: "aggregate_kind = 'project' AND stream_id = ?",
          params: [projectId],
        });
      }
      for (const threadId of input.threadIds) {
        for (const table of tables) {
          if (!present.has(table)) continue;
          yield* transfer({
            src: input.src,
            dst,
            table,
            where: "thread_id = ?",
            params: [threadId],
          });
        }
        yield* transfer({
          src: input.src,
          dst,
          table: "orchestration_events",
          where: "aggregate_kind = 'thread' AND stream_id = ?",
          params: [threadId],
        });
        yield* transfer({
          src: input.src,
          dst,
          table: TRANSFERS_TABLE,
          where: "(source_thread_id = ? OR target_thread_id = ?)",
          params: [threadId, threadId],
        });
      }
    }).pipe(Effect.provide(staging));
    yield* runMigrations().pipe(Effect.provide(staging));
  });

  /** The copy proper: everything is read from `src`, which holds one consistent view of the picked rows. */
  const copyAll = Effect.fn("T3CodeImport.copyAll")(function* (input: {
    readonly src: SqlClient.SqlClient;
    readonly sourceStateDir: string;
    readonly runId: number;
    readonly analysis: Analysis;
  }) {
    const { src, sourceStateDir, runId, analysis } = input;
    const ids = new Map<string, string>([...analysis.threadTargets, ...analysis.omittedTargets]);
    for (const project of analysis.projects.values()) ids.set(project.sourceId, project.targetId);
    const taskIds = new Map<string, string>();
    for (const row of yield* src.unsafe<Row>(`SELECT task_id FROM scheduled_tasks`)) {
      const sourceTask = String(row.task_id);
      taskIds.set(sourceTask, yield* taskTargetId(sourceTask));
    }
    const rewriter = makeRewriter({
      ids,
      taskIds,
      sourceStateDir,
      targetAttachmentsDir: config.attachmentsDir,
      targetBrowserArtifactsDir: config.browserArtifactsDir,
    });
    const tableNames = yield* threadTables();
    const tables = yield* Effect.forEach(tableNames, (name) =>
      sharedColumns(src, name).pipe(Effect.map((columns) => ({ name, columns }))),
    );
    const eventColumns = (yield* sharedColumns(src, "orchestration_events")).filter(
      (column) => column !== "sequence",
    );
    const projectRootRows = yield* src.unsafe<Row>(
      `SELECT project_id, workspace_root FROM projection_projects`,
    );
    const context: RunContext = {
      analysis,
      src,
      tables,
      eventColumns,
      rewrite: rewriter.rewrite,
      referencedFiles: rewriter.referencedFiles,
      copiedFiles: new Set(),
      counters: {
        refsCopied: 0,
        refsUnavailable: 0,
        refsConflicting: 0,
        attachments: 0,
        browserArtifacts: 0,
        limitCleared: 0,
      },
      sourceStateDir,
      projectRoots: new Map(
        projectRootRows.map((row) => [String(row.project_id), String(row.workspace_root)]),
      ),
    };

    yield* markWorktrees(analysis.toCopy);
    let importedProjects = 0;
    for (const project of analysis.projects.values()) {
      if (project.existing) continue;
      yield* copyProject(context, project);
      importedProjects += 1;
    }
    let done = 0;
    // Replacements that were stopped at the last look, with why.
    const stopped = new Map<string, "busy" | "changed" | "session">();
    for (const thread of analysis.toCopy) {
      yield* SubscriptionRef.set(stateRef, {
        status: "running",
        phase: "threads",
        doneThreads: done,
        totalThreads: analysis.toCopy.length,
        currentTitle: thread.title,
      });
      const outcome = yield* copyThread(context, thread);
      if (outcome !== "copied") stopped.set(thread.id, outcome);
      done += 1;
    }

    // Subagents left out: where they stand now is the baseline later updates are measured from.
    for (const { sub, owners } of analysis.omittedToRecord) {
      // A parent that was not replaced did not take the news, so the subagent's news is still news.
      if (owners.every((owner) => stopped.has(owner))) continue;
      const version =
        (yield* src.unsafe<{ readonly version: number | null }>(
          `SELECT MAX(stream_version) AS version FROM orchestration_events
           WHERE aggregate_kind = 'thread' AND stream_id = ?`,
          [sub.id],
        ))[0]?.version ?? -1;
      const runs =
        (yield* src.unsafe<{ readonly ordinal: number | null }>(
          `SELECT MAX(ordinal) AS ordinal FROM orchestration_v2_projection_runs WHERE thread_id = ?`,
          [sub.id],
        ))[0]?.ordinal ?? 0;
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO fork_t3code_import_map (kind, source_id, target_id, state, detail, imported_at, source_version, source_runs)
         VALUES ('thread', ?, ?, 'omitted', NULL, ?, ?, ?)`,
        [sub.id, analysis.omittedTargets.get(sub.id) ?? sub.id, yield* nowIso, version, runs],
      );
    }

    yield* SubscriptionRef.set(stateRef, {
      status: "running",
      phase: "files",
      doneThreads: done,
      totalThreads: analysis.toCopy.length,
      currentTitle: null,
    });
    const lateAttention: Array<T3CodeImportNotice> = [];
    yield* copyReferencedFiles(context, []);
    yield* importFiles(analysis, sourceStateDir, lateAttention);

    yield* SubscriptionRef.set(stateRef, {
      status: "running",
      phase: "tasks",
      doneThreads: done,
      totalThreads: analysis.toCopy.length,
      currentTitle: null,
    });
    const {
      imported: importedTasks,
      unreadable: unreadableTasks,
      secretNotices,
    } = yield* importScheduledTasks(analysis);

    // The final list reports what actually happened.
    const counters = context.counters;
    const replaceCount = (
      notices: ReadonlyArray<T3CodeImportNotice>,
      code: T3CodeImportNotice["code"],
      count: number,
    ) => [
      ...notices.filter((notice) => notice.code !== code),
      ...(count > 0 ? [{ code, subject: "", count }] : []),
    ];
    let fixed = replaceCount(analysis.report.fixed, "checkpoint-refs-copied", counters.refsCopied);
    fixed = replaceCount(
      fixed,
      "attachments-copied",
      counters.attachments + counters.browserArtifacts,
    );
    const attention = [
      ...replaceCount(
        replaceCount(
          analysis.report.attention,
          "checkpoint-refs-unavailable",
          counters.refsUnavailable,
        ),
        "checkpoint-refs-conflict",
        counters.refsConflicting,
      ),
      ...lateAttention,
      ...importedTasks.flatMap((task) =>
        task.webhookPath === null
          ? []
          : [
              {
                code: "task-webhook-url" as const,
                subject: task.title,
                detail: task.webhookPath,
              },
            ],
      ),
      ...secretNotices,
    ];
    // A replacement that was stopped at the last look is not an import; its warning is withdrawn too.
    const stoppedTitles = new Set(
      analysis.toCopy.filter((thread) => stopped.has(thread.id)).map((thread) => thread.title),
    );
    const stoppedNotices = analysis.toCopy.flatMap((thread): Array<T3CodeImportNotice> => {
      const why = stopped.get(thread.id);
      return why === undefined
        ? []
        : [
            {
              code:
                why === "busy"
                  ? "thread-target-busy"
                  : why === "session"
                    ? "thread-target-session"
                    : "thread-target-changed",
              subject: thread.title,
            },
          ];
    });
    fixed = replaceCount(fixed, "thread-refreshed", analysis.refreshing.size - stopped.size);
    const result: T3CodeImportResult = {
      importedProjects,
      importedThreads: analysis.toCopy.length - stopped.size,
      existingThreads: analysis.alreadyImported,
      importedTasks,
      clientSettings: analysis.files.clientSettings,
      report: {
        fixed,
        skipped: [...analysis.report.skipped, ...stoppedNotices, ...unreadableTasks],
        attention: attention.filter(
          (notice) =>
            notice.code !== "thread-local-discarded" || !stoppedTitles.has(notice.subject),
        ),
      },
    };
    yield* sql.unsafe(
      `UPDATE fork_t3code_import_runs SET finished_at = ?, summary_json = ? WHERE run_id = ?`,
      [
        yield* nowIso,
        // A signing secret is shown once, in the dialog; the stored summary never holds it.
        encodeJson({
          ...result.report,
          attention: result.report.attention.filter(
            (notice) => notice.code !== "task-webhook-secret",
          ),
        }),
        runId,
      ],
    );
    return result;
  });

  const inReadTransaction = Effect.fn("T3CodeImport.inReadTransaction")(function* <A, E, R>(
    src: SqlClient.SqlClient,
    use: Effect.Effect<A, E, R>,
  ) {
    yield* SubscriptionRef.set(stateRef, {
      status: "running",
      phase: "preparing",
      doneThreads: 0,
      totalThreads: 0,
      currentTitle: null,
    });
    // One read transaction: every row comes from the same moment, however long the copy takes.
    yield* src.unsafe("BEGIN").unprepared;
    return yield* use.pipe(Effect.ensuring(src.unsafe("ROLLBACK").unprepared.pipe(Effect.ignore)));
  });

  const runImport = Effect.fn("T3CodeImport.runImport")(function* (
    selection: T3CodeImportSelection,
  ) {
    const located = yield* locateSource();
    if (located.problem !== null) return yield* new T3CodeImportError({ reason: located.problem });
    const runId = (yield* sql.unsafe<{ readonly run_id: number }>(
      `INSERT INTO fork_t3code_import_runs (started_at, source_path) VALUES (?, ?) RETURNING run_id`,
      [yield* nowIso, located.sourcePath],
    ))[0]!.run_id;
    const sourceStateDir = path.dirname(located.sourcePath);

    if (!located.needsMigration) {
      return yield* withSource(located.sourcePath, (src) =>
        inReadTransaction(
          src,
          Effect.gen(function* () {
            const analysis = yield* analyse(
              { dbPath: located.sourcePath, stateDir: sourceStateDir },
              src,
              selection,
            );
            return yield* copyAll({ src, sourceStateDir, runId, analysis });
          }),
        ),
      );
    }

    // Runs are serialized, so a staging folder still here belongs to a run a crash cut short.
    const leftovers = yield* fs
      .readDirectory(config.stateDir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const name of leftovers.filter((entry) => entry.startsWith("t3-import-"))) {
      yield* fs
        .remove(path.join(config.stateDir, name), { recursive: true, force: true })
        .pipe(Effect.ignore);
    }
    const tempDir = yield* fs.makeTempDirectoryScoped({
      directory: config.stateDir,
      prefix: "t3-import-",
    });
    const stagingPath = path.join(tempDir, "statev2.sqlite");
    const sourceVersion = Math.max(
      ...(recordedMigrations(located.sourcePath) ?? []).map(({ id }) => id),
    );
    const analysis = yield* withSource(located.sourcePath, (src) =>
      inReadTransaction(
        src,
        Effect.gen(function* () {
          const analysis = yield* analyse(
            { dbPath: located.sourcePath, stateDir: sourceStateDir },
            src,
            selection,
          );
          yield* stageSelection({
            src,
            stagingPath,
            sourceVersion,
            threadIds: analysis.toCopy.map((thread) => thread.id),
            projectIds: [...analysis.projects.keys()],
          });
          return analysis;
        }),
      ),
    );
    return yield* withSource(stagingPath, (src) =>
      inReadTransaction(src, copyAll({ src, sourceStateDir, runId, analysis })),
    );
  }, Effect.scoped);

  const start: T3CodeImport["Service"]["start"] = Effect.fn("T3CodeImport.start")(
    function* (selection) {
      const current = yield* SubscriptionRef.get(stateRef);
      if (current.status === "running")
        return yield* new T3CodeImportError({ reason: "already-running" });
      yield* SubscriptionRef.set(stateRef, {
        status: "running",
        phase: "preparing",
        doneThreads: 0,
        totalThreads: 0,
        currentTitle: null,
      });
      yield* importLock
        .withPermits(1)(
          runImport(selection).pipe(
            Effect.matchEffect({
              // Every run also finishes any relink an earlier try left pending, whatever it imported.
              onSuccess: (result) =>
                relinkQuietly.pipe(
                  Effect.andThen(SubscriptionRef.set(stateRef, { status: "finished", result })),
                ),
              onFailure: (cause) =>
                Effect.logWarning("Import from T3 Code failed", { cause }).pipe(
                  Effect.andThen(relinkQuietly),
                  Effect.andThen(
                    SubscriptionRef.set(stateRef, {
                      status: "failed",
                      message: isImportError(cause) ? cause.message : String(cause),
                    }),
                  ),
                ),
            }),
          ),
        )
        .pipe(Effect.forkIn(scope));
    },
  );

  // Tasks an earlier build imported; once linked they are marked, so later starts do nothing.
  yield* relinkInBackground;

  return T3CodeImport.of({
    preview,
    check,
    start,
    state: SubscriptionRef.changes(stateRef),
    relinkTaskMessages,
  });
});

// One lock instance serves the orchestrator and this service: `ThreadCommandExecutor.layer` is a single
// layer value, so building the server's layers once shares it.
export const layer = Layer.effect(T3CodeImport, make({})).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);

/** Reads another home than ~/.t3; tests point it at fixture databases. */
export const layerWithSourceHome = (sourceHome: string) =>
  Layer.effect(T3CodeImport, make({ sourceHome }));
