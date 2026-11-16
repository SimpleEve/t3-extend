// @effect-diagnostics nodeBuiltinImport:off - fixtures build a real git repository to prove ref copies.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ThreadId,
  type ManagedPolicySummary,
  type T3CodeImportSelection,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { BUILD_MIGRATION_HEAD } from "../persistence/databaseMigrationHead.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Keybindings from "../keybindings.ts";
import * as SharedWorktrees from "./SharedWorktrees.ts";
import * as T3CodeImport from "./T3CodeImport.ts";
import { uuidFromDigest } from "./T3CodeImportRewrite.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P_KEPT = id(1);
const P_SOLO = id(2);
const P_DELETED = id(3);
const T_STOPPED = id(11);
const T_FORK = id(12);
const T_RUNNING = id(13);
const T_ARCHIVED = id(14);
const T_LIMIT = id(15);
const T_PARENT = id(16);
const T_SUB = id(17);
const T_DELETED = id(18);
const T_SOLO = id(19);
/** What the allocator makes of a delegated task's thread: colons in the id, and `%3A` already inside it. */
const T_COLON =
  "thread:delegated-task:command%3Amcp%3A8842e825-5e61-4de5-8b58-077dd48645b7%3Adelegate-task%3Aimpl";
const encodePart = (part: string | number) => encodeURIComponent(String(part));
const joinId = (prefix: string, ...parts: ReadonlyArray<string | number>) =>
  [prefix, ...parts.map(encodePart)].join(":");
const colonScopeId = joinId("checkpoint-scope", "thread", T_COLON, "name", "root");
const TASK_INTERVAL = "scheduled-task:aaaa";
const TASK_SIGNED = "scheduled-task:ffff";
const TASK_WEBHOOK = "scheduled-task:bbbb";
const TASK_ORPHAN = "scheduled-task:cccc";
const TASK_ONCE_PAST = "scheduled-task:dddd";
const TASK_ONCE_FUTURE = "scheduled-task:eeee";
const CURSOR_CREDENTIAL =
  "provider-auth-02a8ae355046b982b21f46e0b092be604758b64fa8ae971800289f628c780a54";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const git = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

const insertThread = Effect.fn("insertThread")(function* (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly runStatus: string;
  readonly payload: object;
  readonly updatedAt: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${input.threadId}, ${input.projectId}, ${`title ${input.threadId.slice(-2)}`}, 'codex', 'full-access', 'default', '2026-08-01', ${input.updatedAt}, ${JSON.stringify(input.payload)})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES (${`run:thread:${input.threadId}:ordinal:1`}, ${input.threadId}, 1, 'codex', ${input.runStatus}, '2026-08-01', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages
    (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${`message:${input.threadId}`}, ${input.threadId}, ${`run:thread:${input.threadId}:ordinal:1`}, 'user', 0, '2026-08-01', '2026-08-01',
      ${JSON.stringify({ text: "hello", attachment: `${input.threadId}-photo` })})`;
  yield* sql`INSERT INTO orchestration_events
    (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
    VALUES
    (${`created-${input.threadId}`}, 'thread', ${input.threadId}, 0, 'thread.created', '2026-08-01', 'user',
      ${JSON.stringify({ projectId: input.projectId, threadId: input.threadId })}, '{}', 2),
    (${`settled-${input.threadId}`}, 'thread', ${input.threadId}, 1, 'thread.settled', '2026-08-02', 'user',
      ${JSON.stringify({ projectId: input.projectId })}, '{}', 2)`;
});

const oldScopeId = `checkpoint-scope:thread:${T_STOPPED}:name:root`;

/** A source home shaped like ~/.t3 on a migrated database, with the neighbours a real install has. */
const createSourceHome = Effect.fn("createSourceHome")(function* (
  home: string,
  repo: string,
  throughMigration: number | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(home, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(path.join(stateDir, "attachments"), { recursive: true });
  yield* fs.makeDirectory(path.join(stateDir, "secrets"), { recursive: true });
  yield* fs.makeDirectory(path.join(stateDir, "themes"), { recursive: true });
  yield* fs.writeFileString(path.join(stateDir, "attachments", `${T_STOPPED}-photo.png`), "png");
  yield* fs.writeFileString(path.join(stateDir, "attachments", `${T_RUNNING}-photo.png`), "png");
  yield* fs.writeFileString(path.join(stateDir, "themes", "dusk.json"), "{}");
  yield* fs.writeFileString(path.join(stateDir, "environment-id"), "official-environment");
  yield* fs.writeFileString(path.join(stateDir, "connection-catalog.json"), "{}");
  yield* fs.writeFileString(path.join(stateDir, "secrets", "server-signing-key.bin"), "k");
  yield* fs.writeFileString(path.join(stateDir, "secrets", CURSOR_CREDENTIAL + ".bin"), "token");
  yield* fs.writeFileString(
    path.join(stateDir, "settings.json"),
    JSON.stringify({
      favorites: [{ provider: "codex", model: "gpt-x" }],
      projectSettingsFolded: true,
      previousWorktreesDirectories: [path.join(home, "worktrees")],
      worktreesDirectory: path.join(home, "worktrees"),
      providerInstances: { cursor: { driver: "cursor", displayName: "Cursor", enabled: true } },
    }),
  );
  yield* fs.writeFileString(
    path.join(stateDir, "client-settings.json"),
    JSON.stringify({ diffLayout: "split", legacySidebarEnabled: true, notAClientSetting: 1 }),
  );
  yield* fs.writeFileString(
    path.join(stateDir, "keybindings.json"),
    JSON.stringify([{ key: "mod+k", command: "chat.new" }, { command: 5 }]),
  );
  const worktree = path.join(home, "worktrees", "kept", "feature");
  yield* fs.makeDirectory(worktree, { recursive: true });
  const oldRef = yield* checkpointRefForScopeOrdinal({
    scopeId: oldScopeId as never,
    ordinalWithinScope: 0,
  });
  git(repo, ["update-ref", oldRef, "HEAD"]);
  const colonRef = yield* checkpointRefForScopeOrdinal({
    scopeId: colonScopeId as never,
    ordinalWithinScope: 0,
  });
  git(repo, ["update-ref", colonRef, "HEAD"]);

  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(
        throughMigration === undefined ? {} : { toMigrationInclusive: throughMigration },
      );
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        (${P_KEPT}, 'Kept', ${repo}, '[]', '2026-08-01', '2026-08-01', NULL),
        (${P_SOLO}, 'Solo', '/tmp/solo', '[]', '2026-08-01', '2026-08-01', NULL),
        (${P_DELETED}, 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES ('project-created-solo', 'project', ${P_SOLO}, 0, 'project.created', '2026-08-01', 'user', ${JSON.stringify({ projectId: P_SOLO })}, '{}', 2)`;

      const parent = (parentId: string, relationship: string) => ({
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: relationship,
          rootThreadId: parentId,
        },
      });
      for (const thread of [
        [T_STOPPED, P_KEPT, "completed", { worktreePath: worktree }, "2026-08-01"],
        [T_FORK, P_KEPT, "completed", parent(T_STOPPED, "fork"), "2026-08-02"],
        [T_RUNNING, P_KEPT, "running", {}, "2026-08-05"],
        [T_ARCHIVED, P_KEPT, "completed", { archivedAt: "2026-08-01" }, "2026-08-05"],
        [T_LIMIT, P_KEPT, "completed", { limitRecovery: { autoResume: true } }, "2026-08-05"],
        [T_PARENT, P_KEPT, "completed", {}, "2026-08-05"],
        [T_SUB, P_KEPT, "completed", parent(T_PARENT, "subagent"), "2026-08-05"],
        [T_DELETED, P_KEPT, "completed", { deletedAt: "2026-08-03" }, "2026-08-05"],
        [
          T_SOLO,
          P_SOLO,
          "completed",
          {
            worktreePath: path.join(home, "worktrees", "gone"),
            // What migration 077 repairs; only an older source still holds it.
            ...(throughMigration === undefined ? {} : { settledOverride: true }),
          },
          "2026-08-06",
        ],
      ] as const) {
        yield* insertThread({
          threadId: thread[0],
          projectId: thread[1],
          runStatus: thread[2],
          payload: thread[3],
          updatedAt: thread[4],
        });
      }
      yield* insertThread({
        threadId: T_COLON,
        projectId: P_SOLO,
        runStatus: "completed",
        payload: {},
        updatedAt: "2026-08-07",
      });
      // The parent's card for its subagent, an event about it and a hand-off to it.
      yield* sql`INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, run_id, parent_node_id, provider, provider_thread_id, child_thread_id, origin, status, started_at, completed_at, updated_at, payload_json)
        VALUES ('subagent-1', ${T_PARENT}, ${`run:thread:${T_PARENT}:ordinal:1`}, 'node', 'codex', NULL, ${T_SUB}, 'native', 'completed', '2026-08-01', '2026-08-02', '2026-08-02',
          ${JSON.stringify({ subagentId: "subagent-1", childThreadId: T_SUB, parentThreadId: T_PARENT })})`;
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES ('subagent-spawned', 'thread', ${T_PARENT}, 2, 'subagent.spawned', '2026-08-03', 'user',
          ${JSON.stringify({ childThreadId: T_SUB, encoded: encodePart(T_SUB) })}, '{}', 2)`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-sub', ${T_PARENT}, ${T_SUB}, 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      // A thread whose id needs encoding in every id built from it.
      const colonRunId = joinId("run", "thread", T_COLON, "ordinal", 1);
      const colonNodeId = joinId("node", "run", colonRunId, "root");
      yield* sql`INSERT INTO ${sql("orchestration_v2_projection_checkpoint_scopes")}
        (scope_id, thread_id, run_id, node_id, parent_scope_id, provider_thread_id, kind, ordinal_within_parent, advances_app_run_count, created_at, payload_json)
        VALUES (${colonScopeId}, ${T_COLON}, ${colonRunId}, ${colonNodeId}, NULL, 'provider-thread', 'root_run', 0, 1, '2026-08-01',
          ${JSON.stringify({ id: colonScopeId, threadId: T_COLON, runId: colonRunId, nodeId: colonNodeId, cwd: repo })})`;
      const colonCheckpointId = joinId("checkpoint", "scope", colonScopeId, "name", 0);
      yield* sql`INSERT INTO ${sql("orchestration_v2_projection_checkpoints")}
        (checkpoint_id, thread_id, scope_id, run_id, node_id, parent_checkpoint_id, ordinal_within_scope, app_run_ordinal, status, captured_at, payload_json)
        VALUES (${colonCheckpointId}, ${T_COLON}, ${colonScopeId}, NULL, ${colonNodeId}, NULL, 0, NULL, 'ready', '2026-08-01',
          ${JSON.stringify({ id: colonCheckpointId, ref: colonRef, scopeId: colonScopeId, threadId: T_COLON, ordinalWithinScope: 0, status: "ready" })})`;
      yield* sql`INSERT INTO ${sql("orchestration_v2_projection_checkpoint_scopes")}
        (scope_id, thread_id, run_id, node_id, parent_scope_id, provider_thread_id, kind, ordinal_within_parent, advances_app_run_count, created_at, payload_json)
        VALUES (${oldScopeId}, ${T_STOPPED}, ${`run:thread:${T_STOPPED}:ordinal:1`}, 'node', NULL, 'provider-thread', 'root_run', 0, 1, '2026-08-01',
          ${JSON.stringify({ id: oldScopeId, threadId: T_STOPPED, cwd: repo })})`;
      yield* sql`INSERT INTO ${sql("orchestration_v2_projection_checkpoints")}
        (checkpoint_id, thread_id, scope_id, run_id, node_id, parent_checkpoint_id, ordinal_within_scope, app_run_ordinal, status, captured_at, payload_json)
        VALUES (${`checkpoint:${T_STOPPED}:0`}, ${T_STOPPED}, ${oldScopeId}, NULL, 'node', NULL, 0, NULL, 'ready', '2026-08-01',
          ${JSON.stringify({ ref: oldRef, scopeId: oldScopeId, ordinalWithinScope: 0, status: "ready" })})`;
      // The event the projection above was built from; a rebuild reads this one.
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES ('checkpoint-captured-stopped', 'thread', ${T_STOPPED}, 2, 'checkpoint.captured', '2026-08-01', 'user',
          ${JSON.stringify({ ref: oldRef, scopeId: oldScopeId, ordinalWithinScope: 0, status: "ready" })}, '{}', 2)`;
      yield* sql`INSERT INTO ${sql("orchestration_v2_projection_provider_threads")}
        (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json, driver, provider_instance_id)
        VALUES ('provider-thread:1', ${T_STOPPED}, NULL, 'codex', 'live-session', 'idle', 1, 1, '2026-08-01',
          ${JSON.stringify({ providerSessionId: "live-session", status: "idle", nativeThreadRef: { nativeId: "native-1" } })}, 'codex', 'codex')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('live-session', ${T_STOPPED}, 'codex', 'ready', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id) VALUES ('live-session', ${T_STOPPED})`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', ${T_ARCHIVED}, ${T_STOPPED}, 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      const task = (
        taskId: string,
        project: string,
        schedule: object,
        enabled: number,
        threadId: string | null,
      ) =>
        sql`INSERT INTO scheduled_tasks
          (task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json,
            model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
            created_at, updated_at, last_run_status, run_count, webhook_token, webhook_secret)
          VALUES (${taskId}, ${`Task ${taskId}`}, 'Run it', ${enabled}, ${JSON.stringify(schedule)}, ${project}, ${threadId},
            '{"type":"root"}', '{"instanceId":"codex","model":"gpt-x"}', 'full-access', 'default', 'user', 'user',
            '2026-08-01', '2026-08-01', 'never', 0, ${schedule === null ? null : "old-token"}, 'secret')`;
      yield* task(TASK_INTERVAL, P_KEPT, { type: "interval", everyMs: 3_600_000 }, 1, null);
      yield* task(
        TASK_WEBHOOK,
        P_SOLO,
        { type: "webhook", signature: null, maxDeliveryAgeMinutes: null },
        0,
        null,
      );
      yield* task(TASK_ORPHAN, P_DELETED, { type: "interval", everyMs: 3_600_000 }, 1, null);
      yield* task(
        TASK_ONCE_PAST,
        P_KEPT,
        { type: "once", runAt: "2020-01-01T00:00:00.000Z" },
        1,
        null,
      );
      yield* task(
        TASK_SIGNED,
        P_KEPT,
        {
          type: "webhook",
          signature: { header: "x-signature", encoding: "hex", prefix: "sha256=" },
          maxDeliveryAgeMinutes: null,
        },
        1,
        null,
      );
      yield* task(
        TASK_ONCE_FUTURE,
        P_KEPT,
        { type: "once", runAt: "2999-01-01T00:00:00.000Z" },
        1,
        null,
      );
      yield* sql`INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
        VALUES ('command-1', 'thread', ${T_STOPPED}, '2026-08-01', 1, 'accepted')`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
      yield* sql`INSERT INTO peer_environment_links
        (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
        VALUES ('environment-box', 'peer-link-box', 'Box', '["https://box.example"]', 'auto', '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

const selectionOf = (overrides: Partial<T3CodeImportSelection> = {}): T3CodeImportSelection => ({
  threadIds: [T_STOPPED, T_FORK, T_RUNNING, T_ARCHIVED, T_LIMIT, T_PARENT, T_SOLO].map((threadId) =>
    ThreadId.make(threadId),
  ),
  projectIds: [],
  includeSubagents: true,
  scheduledTasks: [
    { taskId: TASK_INTERVAL, enabled: true },
    { taskId: TASK_WEBHOOK, enabled: false },
    { taskId: TASK_ORPHAN, enabled: true },
  ],
  files: [
    "settings",
    "clientSettings",
    "keybindings",
    "themes",
    "usagePriceOverrides",
    "providerInstances",
  ],
  ...overrides,
});

const codes = (notices: ReadonlyArray<{ readonly code: string; readonly subject: string }>) =>
  notices.map((notice) => notice.code);

interface Captured {
  readonly tasks: Array<Record<string, unknown>>;
  readonly keybindings: Array<Record<string, unknown>>;
  readonly secrets: Map<string, Uint8Array>;
}

/** Runs `use` against a live service on a fresh target database, as the server would hold it. */
const withService = <A, E, R>(
  options: {
    readonly sourceThroughMigration?: number;
    readonly managedPolicy?: ManagedPolicySummary;
    readonly withoutSharedWorktreePolicy?: boolean;
    /** Receives how many worktree markers the database held each time the import marks in memory. */
    readonly markCalls?: Array<number>;
    /** Swaps the event store for one that records what the import tells live clients, by thread id. */
    readonly announced?: Array<string>;
  },
  use: (input: {
    readonly service: T3CodeImport.T3CodeImport["Service"];
    readonly sql: SqlClient.SqlClient;
    readonly config: ServerConfig.ServerConfig["Service"];
    readonly home: string;
    readonly sourcePath: string;
    readonly repo: string;
    readonly captured: Captured;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-code-import-" });
    const home = path.join(root, "official");
    const repo = path.join(root, "repo");
    yield* fs.makeDirectory(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
    const sourcePath = yield* createSourceHome(home, repo, options.sourceThroughMigration);
    yield* withDatabase(
      config.dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
          VALUES ('project-here', 'Kept here', ${repo}, '[]', '2026-09-01', '2026-09-01', NULL)`;
        yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_metadata
          (projection_name, schema_version, last_sequence, updated_at)
          VALUES ('thread-projections', 2, 0, '2026-09-01')`;
      }),
    );
    const captured: Captured = { tasks: [], keybindings: [], secrets: new Map() };
    const announced = options.announced;
    const mocks = Layer.mergeAll(
      announced === undefined
        ? OrchestrationEventStore.layer
        : Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
            // The fixtures' creation events are not full threads, so the real store cannot decode them.
            readAgentEvents: (input) => Stream.make({ threadId: input.threadId } as never),
            readApplicationEvents: () => Stream.empty,
            publishCommitted: (events) =>
              Effect.sync(() => {
                for (const event of events)
                  announced.push((event as never as { threadId: string }).threadId);
              }),
          }),
      ServerSettings.ServerSettingsService.layerTest({}, options.managedPolicy),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        upsert: (input) =>
          Effect.sync(() => {
            captured.tasks.push(input as never);
            return {
              task: {
                webhook:
                  input.schedule.type === "webhook"
                    ? { path: `/api/hooks/${input.id}/new-token`, url: null, hasSecret: false }
                    : undefined,
              },
            } as never;
          }),
      }),
      Layer.mock(Keybindings.Keybindings)({
        upsertKeybindingRule: (input) =>
          Effect.sync(() => {
            captured.keybindings.push(input as never);
            return undefined as never;
          }),
      }),
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromNullishOr(captured.secrets.get(name))),
        set: (name, value) => Effect.sync(() => void captured.secrets.set(name, value)),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: (input) =>
          Effect.sync(() => ({
            exitCode: 0 as never,
            stdout: git(input.cwd, input.args, input.stdin),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          })),
      }),
    );
    const sqlite = NodeSqliteClient.layer({ filename: config.dbPath });
    const policyLayer: Layer.Layer<never, never, SqlClient.SqlClient> =
      options.withoutSharedWorktreePolicy === true
        ? Layer.succeed(
            SharedWorktrees.SharedWorktreePolicy,
            SharedWorktrees.SharedWorktreePolicy.defaultValue(),
          )
        : options.markCalls === undefined
          ? SharedWorktrees.layer
          : Layer.effect(
              SharedWorktrees.SharedWorktreePolicy,
              Effect.gen(function* () {
                const sqlClient = yield* SqlClient.SqlClient;
                const built = yield* Layer.build(SharedWorktrees.layer);
                const base = Context.get(built, SharedWorktrees.SharedWorktreePolicy);
                const calls = options.markCalls!;
                return SharedWorktrees.SharedWorktreePolicy.of({
                  ...base,
                  markShared: Effect.fn("test.markShared")(function* (paths) {
                    const rows = yield* sqlClient
                      .unsafe<{ readonly count: number }>(
                        `SELECT COUNT(*) AS count FROM fork_t3code_import_map WHERE kind = 'worktree'`,
                      )
                      .pipe(Effect.orDie);
                    calls.push(Number(rows[0]!.count));
                    yield* base.markShared(paths);
                  }),
                });
              }),
            );
    const layer = T3CodeImport.layerWithSourceHome(home).pipe(
      Layer.provideMerge(mocks),
      // The policy the server provides once at its base, over the same database.
      Layer.provideMerge(policyLayer),
      Layer.provideMerge(sqlite),
    );
    return yield* Effect.gen(function* () {
      const service = yield* T3CodeImport.T3CodeImport;
      const sql = yield* SqlClient.SqlClient;
      return yield* use({ service, sql, config, home, sourcePath, repo, captured });
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provide(
      Layer.merge(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-code-import-target-" }),
        NodeCrypto.layer,
      ),
    ),
  );

/** Official ids (in any spelling) still present in a text column of the target database. */
const sourceIdsLeft = (sql: SqlClient.SqlClient, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spellings = ids.flatMap((id) => [id, encodePart(id), encodePart(encodePart(id))]);
    const tables = yield* sql.unsafe<{ readonly name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'orchestration_v2_message_search%' AND name NOT LIKE 'fork_t3code_import_%'`,
    );
    const found: Array<string> = [];
    for (const { name } of tables) {
      const columns = yield* sql.unsafe<{ readonly name: string }>(
        `SELECT name FROM pragma_table_info(?)`,
        [name],
      );
      for (const spelling of new Set(spellings)) {
        const hit = yield* sql.unsafe(
          `SELECT 1 FROM "${name}" WHERE ${columns
            .map((column) => `CAST("${column.name}" AS TEXT) LIKE ?`)
            .join(" OR ")} LIMIT 1`,
          columns.map(() => `%${spelling}%`),
        );
        if (hit.length > 0) found.push(`${name}: ${spelling}`);
      }
    }
    return found;
  });

const runToEnd = (
  service: T3CodeImport.T3CodeImport["Service"],
  selection: T3CodeImportSelection,
) =>
  Effect.gen(function* () {
    yield* service.start(selection);
    const last = yield* service.state.pipe(
      Stream.filter((state) => state.status === "finished" || state.status === "failed"),
      Stream.runHead,
    );
    const state = Option.getOrThrow(last);
    if (state.status !== "finished") return yield* Effect.die(state);
    return state.result;
  });

const hashFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Digest.Digest;
    const digest = yield* crypto.digest(Digest.sha256, yield* fs.readFile(file)).pipe(Effect.orDie);
    return Array.from(digest).join(",");
  });

it.layer(NodeServices.layer)("T3CodeImport", (it) => {
  it.effect(
    "lists what can be picked: busy threads are marked, a known folder joins its project",
    () =>
      withService({}, ({ service }) =>
        Effect.gen(function* () {
          const catalog = yield* service.preview;
          assert.equal(catalog.status, "available");
          if (catalog.status !== "available") return;
          const kept = catalog.projects.find((project) => project.projectId === P_KEPT)!;
          assert.equal(kept.joinsProjectId, "project-here");
          // Subagents travel with their parent instead of being listed.
          assert.deepStrictEqual(
            kept.threads
              .map(
                (thread) =>
                  [thread.threadId.slice(-2), thread.state, thread.subagentCount] as const,
              )
              .toSorted((a, b) => a[0].localeCompare(b[0])),
            [
              ["11", "importable", 0],
              ["12", "importable", 0],
              ["13", "busy", 0],
              ["14", "importable", 0],
              ["15", "importable", 0],
              ["16", "importable", 1],
            ],
          );
          assert.deepStrictEqual(
            catalog.scheduledTasks.map((task) => task.enabled),
            [true, false, true, true, true, true],
          );
          assert.deepStrictEqual(
            catalog.files.filter((file) => !file.available).map((file) => file.kind),
            ["usagePriceOverrides"],
          );
        }),
      ),
  );

  it.effect(
    "sorts every selected item into fixed, skipped and needing attention before anything is written",
    () =>
      withService({}, ({ service, sql, sourcePath, repo }) =>
        Effect.gen(function* () {
          const sourceBefore = yield* hashFile(sourcePath);
          const refsBefore = git(repo, ["for-each-ref"]);
          yield* service.preview;
          const report = yield* service.check(selectionOf());
          assert.deepStrictEqual(codes(report.fixed).toSorted(), [
            "attachments-copied",
            "checkpoint-refs-copied",
            "limit-recovery-cleared",
            "paths-rewritten",
            "project-merged",
            "task-imported-active",
            "thread-ids-renewed",
          ]);
          const skipped = codes(report.skipped);
          for (const code of [
            "thread-busy",
            "task-project-missing",
            "identity-skipped",
            "signing-secrets-skipped",
            "connection-catalog-skipped",
            "browser-storage-skipped",
            "setting-rejected",
            "worktree-directories-skipped",
            "client-setting-rejected",
            "keybinding-rejected",
          ]) {
            assert.include(skipped, code);
          }
          const attention = codes(report.attention);
          for (const code of [
            "worktree-missing",
            "worktree-shared",
            "provider-files-shared",
            "task-runs-in-both",
            "provider-credential-imported",
            "sidebar-settings",
          ]) {
            assert.include(attention, code);
          }
          // One line names every provider whose credential comes along.
          const credentials = report.attention.filter(
            (notice) => notice.code === "provider-credential-imported",
          );
          assert.equal(credentials.length, 1);
          assert.equal(credentials[0]?.subject.split(", ").length, credentials[0]?.count);
          // The preflight reads only.
          const [rows] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`;
          assert.equal(rows?.count, 0);
          const [bookkeeping] = yield* sql<{
            count: number;
          }>`SELECT (SELECT COUNT(*) FROM fork_t3code_import_map) + (SELECT COUNT(*) FROM fork_t3code_import_runs) AS count`;
          assert.equal(bookkeeping?.count, 0);
          assert.equal(yield* hashFile(sourcePath), sourceBefore);
          assert.equal(git(repo, ["for-each-ref"]), refsBefore);
        }),
      ),
  );

  it.effect(
    "imports into the live database under new ids, arrives stopped, and is idempotent",
    () =>
      withService({}, ({ service, sql, config, sourcePath, home, repo, captured }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sourceHashBefore = yield* hashFile(sourcePath);

          const first = yield* runToEnd(service, selectionOf());
          const eventsAfterFirst = (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_events`)[0]?.count;
          const second = yield* runToEnd(service, selectionOf());
          const eventsAfterSecond = (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_events`)[0]?.count;

          assert.equal(first.importedThreads, 7); // 6 picked and not busy, plus the subagent
          assert.equal(first.importedProjects, 1); // Solo is new; Kept merged into the project already here
          assert.equal(second.importedThreads, 0);
          assert.equal(second.existingThreads, 7);
          assert.equal(eventsAfterFirst, eventsAfterSecond);

          const threads = yield* sql<{
            thread_id: string;
            project_id: string;
            payload_json: string;
          }>`
          SELECT thread_id, project_id, payload_json FROM orchestration_v2_projection_threads`;
          assert.equal(threads.length, 7);
          // New ids everywhere, so the two apps never share a thread, run, scope or checkpoint name.
          assert.isTrue(
            threads.every((row) => ![T_STOPPED, T_FORK, T_SUB].includes(row.thread_id)),
          );
          const every = yield* sql<{ text: string }>`
          SELECT payload_json AS text FROM orchestration_events UNION ALL
          SELECT payload_json FROM orchestration_v2_projection_messages UNION ALL
          SELECT message_id FROM orchestration_v2_projection_messages UNION ALL
          SELECT run_id FROM orchestration_v2_projection_runs`;
          assert.isFalse(
            every.some((row) => row.text.includes(T_STOPPED) || row.text.includes(P_KEPT)),
          );
          const projects = yield* sql<{
            project_id: string;
          }>`SELECT project_id FROM projection_projects ORDER BY project_id`;
          assert.equal(projects.length, 2);
          assert.isTrue(threads.some((row) => row.project_id === "project-here"));

          // Stopped: no live sessions, no pending work, no recovery plans.
          const [live] = yield* sql<Record<string, number>>`SELECT
          (SELECT COUNT(*) FROM orchestration_v2_projection_provider_sessions) AS sessions,
          (SELECT COUNT(*) FROM orchestration_v2_projection_provider_session_bindings) AS bindings,
          (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status IN ('running','queued','waiting','starting','preparing')) AS active,
          (SELECT COUNT(*) FROM orchestration_v2_effect_outbox) AS outbox,
          (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
          (SELECT COUNT(*) FROM orchestration_command_receipts) AS receipts,
          (SELECT COUNT(*) FROM auth_sessions) AS auth,
          (SELECT COUNT(*) FROM peer_environment_links) AS links,
          (SELECT COUNT(*) FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.limitRecovery') IS NOT NULL) AS recovery`;
          assert.deepStrictEqual(live, {
            sessions: 0,
            bindings: 0,
            active: 0,
            outbox: 0,
            tasks: 0,
            receipts: 0,
            auth: 0,
            links: 0,
            recovery: 0,
          });
          const providerThread = (yield* sql<{
            payload_json: string;
            provider_session_id: string | null;
          }>`
          SELECT payload_json, provider_session_id FROM orchestration_v2_projection_provider_threads`)[0]!;
          assert.isNull(providerThread.provider_session_id);
          assert.include(providerThread.payload_json, "native-1");
          assert.include(providerThread.payload_json, '"providerSessionId":null');

          // Checkpoints: the copy lives under the new scope's ref name; the original is untouched.
          const [checkpoint] = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_checkpoints`;
          const newRef = (JSON.parse(checkpoint!.payload_json) as { ref: string }).ref;
          const oldRef = yield* checkpointRefForScopeOrdinal({
            scopeId: oldScopeId as never,
            ordinalWithinScope: 0,
          });
          assert.notEqual(newRef, oldRef);
          assert.equal(git(repo, ["rev-parse", newRef]), git(repo, ["rev-parse", oldRef]));
          assert.equal(
            first.report.fixed.find((n) => n.code === "checkpoint-refs-copied")?.count,
            1,
          );

          // The projection cursor stays at the newest thread event; search covers imported messages.
          const [cursor] = yield* sql<{
            last_sequence: number;
          }>`SELECT last_sequence FROM orchestration_v2_projection_metadata`;
          const [newest] = yield* sql<{ sequence: number }>`
          SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread'`;
          assert.equal(cursor?.last_sequence, newest?.sequence);
          const search = yield* sql<{
            rowid: number;
          }>`SELECT rowid FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH 'hello'`;
          assert.equal(search.length, 6); // the subagent's messages are not indexed

          // Attachments follow their thread under its new id.
          const attachments = yield* fs.readDirectory(config.attachmentsDir);
          assert.equal(attachments.length, 1);
          assert.isTrue(attachments[0]!.endsWith("-photo.png"));
          assert.isFalse(attachments[0]!.startsWith(T_STOPPED));

          // Worktrees are shared: they stay where they are, and the import records them so no remover touches them.
          const worktree = path.join(home, "worktrees", "kept", "feature");
          assert.isTrue(yield* fs.exists(worktree));
          const shared = yield* sql<{
            source_id: string;
          }>`SELECT source_id FROM fork_t3code_import_map WHERE kind = 'worktree'`;
          assert.isTrue(shared.some((row) => row.source_id === path.resolve(worktree)));
          void repo;

          // Tasks, settings and the rest.
          assert.deepStrictEqual(
            first.importedTasks.map((task) => [task.enabled, task.webhookPath === null]),
            [
              [true, true],
              [false, false],
            ],
          );
          assert.deepStrictEqual(
            captured.tasks.map((task) => task.enabled),
            [true, false],
          );
          // A repeated run re-applies chosen files; upserting the same rule again changes nothing.
          assert.deepStrictEqual(
            [...new Set(captured.keybindings.map((rule) => `${rule.key} ${rule.command}`))],
            ["mod+k chat.new"],
          );
          assert.isTrue(captured.secrets.has(CURSOR_CREDENTIAL));
          assert.isFalse(captured.secrets.has("server-signing-key"));
          assert.equal(first.clientSettings?.diffLayout, "split");
          assert.isUndefined(first.clientSettings?.notAClientSetting);
          assert.isTrue(yield* fs.exists(path.join(config.environmentThemesDir, "dusk.json")));
          assert.include(codes(first.report.attention), "task-webhook-url");
          assert.equal(yield* hashFile(sourcePath), sourceHashBefore);
        }),
      ),
  );

  it.effect(
    "a run that stopped halfway starts that thread over instead of leaving a partial copy",
    () =>
      withService({}, ({ service, sql }) =>
        Effect.gen(function* () {
          const selection = selectionOf({
            threadIds: [ThreadId.make(T_SOLO)],
            scheduledTasks: [],
            files: [],
          });
          yield* runToEnd(service, selection);
          yield* sql`UPDATE fork_t3code_import_map SET state = 'copying' WHERE kind = 'thread'`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages`;
          const again = yield* runToEnd(service, selection);
          assert.equal(again.importedThreads, 1);
          const [messages] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages`;
          assert.equal(messages?.count, 1);
          const [threads] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`;
          assert.equal(threads?.count, 1);
        }),
      ),
  );

  it.effect("a thread whose subagent did not arrive is offered again and finishes the job", () =>
    withService({}, ({ service, sql }) =>
      Effect.gen(function* () {
        const selection = selectionOf({
          threadIds: [ThreadId.make(T_PARENT)],
          scheduledTasks: [],
          files: [],
        });
        yield* runToEnd(service, selection);
        const stateOf = Effect.gen(function* () {
          const catalog = yield* service.preview;
          assert.equal(catalog.status, "available");
          if (catalog.status !== "available") return undefined;
          return catalog.projects
            .flatMap((project) => project.threads)
            .find((thread) => thread.threadId === T_PARENT)?.state;
        });
        assert.equal(yield* stateOf, "imported");
        yield* sql`UPDATE fork_t3code_import_map SET state = 'copying' WHERE source_id = ${T_SUB}`;
        assert.equal(yield* stateOf, "importable");
        const again = yield* runToEnd(service, selection);
        assert.equal(again.importedThreads, 1);
        assert.equal(again.existingThreads, 1);
        assert.equal(yield* stateOf, "imported");
      }),
    ),
  );

  it.effect("refuses a source that is missing, newer, or this very database", () =>
    withService({}, ({ service, sourcePath, config }) =>
      Effect.gen(function* () {
        yield* withDatabase(
          sourcePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${BUILD_MIGRATION_HEAD + 1}, 'FromTheFuture')`;
          }),
        );
        const catalog = yield* service.preview;
        assert.deepStrictEqual(
          catalog.status === "unavailable" ? catalog.reason : "available",
          "source-schema-newer",
        );
        const error = yield* Effect.flip(service.check(selectionOf()));
        assert.equal(error.reason, "source-schema-newer");
        void config;
      }),
    ),
  );

  it.effect(
    "migrates an older source through a staging database, leaves the official file as it was and clears staging leftovers",
    () =>
      withService(
        { sourceThroughMigration: 76 }, // just before 077_RepairBooleanSettledOverride, whatever the head is
        ({ service, sql, sourcePath, config }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const leftover = path.join(config.stateDir, "t3-import-crashed");
            yield* fs.makeDirectory(leftover, { recursive: true });
            yield* fs.writeFileString(path.join(leftover, "partial.sqlite"), "half a staging file");
            const before = yield* hashFile(sourcePath);
            const selection = selectionOf({
              threadIds: [ThreadId.make(T_SOLO)],
              scheduledTasks: [],
              files: [],
            });
            const result = yield* runToEnd(service, selection);
            assert.equal(result.importedThreads, 1);
            const [threads] = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`;
            assert.equal(threads?.count, 1);
            const [repaired] = yield* sql<{
              settled: string | null;
            }>`SELECT json_extract(payload_json, '$.settledOverride') AS settled FROM orchestration_v2_projection_threads`;
            assert.equal(repaired?.settled, "settled");
            assert.equal(yield* hashFile(sourcePath), before);
            const staging = (yield* fs.readDirectory(config.stateDir)).filter((name) =>
              name.startsWith("t3-import-"),
            );
            assert.deepStrictEqual(staging, []);
          }),
      ),
  );
  it.effect("imports a one-time task whose time has passed turned off and says so", () =>
    withService({}, ({ service, captured }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-02T00:00:00Z"));
        const selection = selectionOf({
          threadIds: [],
          files: [],
          scheduledTasks: [
            { taskId: TASK_ONCE_PAST, enabled: true },
            { taskId: TASK_ONCE_FUTURE, enabled: true },
          ],
        });
        const report = yield* service.check(selection);
        assert.deepStrictEqual(
          report.attention.filter((notice) => notice.code === "task-once-passed"),
          [{ code: "task-once-passed", subject: `Task ${TASK_ONCE_PAST}` }],
        );
        yield* runToEnd(service, selection);
        assert.deepStrictEqual(
          captured.tasks.map((task) => [(task.schedule as { runAt?: string }).runAt, task.enabled]),
          [
            ["2020-01-01T00:00:00.000Z", false],
            ["2999-01-01T00:00:00.000Z", true],
          ],
        );
      }),
    ),
  );

  it.effect("leaves settings and provider instances a managed policy locks alone", () =>
    withService(
      {
        managedPolicy: {
          organization: "Example Corp",
          lockedSettings: ["worktreesDirectory"],
          limits: { providers: { allowedDrivers: [ProviderDriverKind.make("codex")] } },
        },
      },
      ({ service }) =>
        Effect.gen(function* () {
          const report = yield* service.check(
            selectionOf({
              threadIds: [],
              scheduledTasks: [],
              files: ["settings", "providerInstances"],
            }),
          );
          assert.deepStrictEqual(
            report.skipped.filter(
              (notice) =>
                notice.code === "setting-managed" || notice.code === "provider-instance-managed",
            ),
            [
              { code: "setting-managed", subject: "worktreesDirectory", detail: "Example Corp" },
              { code: "provider-instance-managed", subject: "cursor", detail: "Example Corp" },
            ],
          );
        }),
    ),
  );
  it.effect(
    "never moves a checkpoint ref that already exists under the name a copy would take",
    () =>
      withService({}, ({ service, sql, repo }) =>
        Effect.gen(function* () {
          const crypto = yield* Digest.Digest;
          const digest = yield* crypto
            .digest(Digest.sha256, new TextEncoder().encode(`t3x-import|thread|${T_STOPPED}`))
            .pipe(Effect.orDie);
          const targetThread = uuidFromDigest(digest);
          const targetRef = yield* checkpointRefForScopeOrdinal({
            scopeId: oldScopeId.replace(T_STOPPED, targetThread) as never,
            ordinalWithinScope: 0,
          });
          const sourceSha = git(repo, ["rev-parse", "HEAD"]).trim();
          git(repo, ["commit", "-q", "--allow-empty", "-m", "continued in T3 Extend"]);
          const otherSha = git(repo, ["rev-parse", "HEAD"]).trim();
          assert.notEqual(otherSha, sourceSha);
          git(repo, ["update-ref", targetRef, otherSha]);

          const selection = selectionOf({
            threadIds: [ThreadId.make(T_STOPPED)],
            scheduledTasks: [],
            files: [],
          });
          const result = yield* runToEnd(service, selection);

          assert.equal(git(repo, ["rev-parse", targetRef]).trim(), otherSha);
          assert.deepStrictEqual(
            result.report.attention.filter((notice) => notice.code === "checkpoint-refs-conflict"),
            [{ code: "checkpoint-refs-conflict", subject: "", count: 1 }],
          );
          assert.notInclude(codes(result.report.fixed), "checkpoint-refs-copied");
          assert.notInclude(codes(result.report.attention), "checkpoint-refs-unavailable");
          // The projection and the events a rebuild reads say the same thing: missing, and the
          // source's ref, since no copy was made under a new name.
          const [checkpoint] = yield* sql<{
            status: string;
            payload_json: string;
          }>`SELECT status, payload_json FROM orchestration_v2_projection_checkpoints`;
          const [event] = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_events WHERE event_type = 'checkpoint.captured'`;
          const projected = JSON.parse(checkpoint!.payload_json) as { ref: string; status: string };
          const replayed = JSON.parse(event!.payload_json) as { ref: string; status: string };
          assert.equal(checkpoint?.status, "missing");
          assert.equal(projected.status, "missing");
          assert.equal(replayed.status, "missing");
          assert.equal(projected.ref, replayed.ref);
          assert.equal(
            projected.ref,
            yield* checkpointRefForScopeOrdinal({
              scopeId: oldScopeId as never,
              ordinalWithinScope: 0,
            }),
          );
        }),
      ),
  );

  it.effect("shows a ref that would conflict in the review step, without writing anything", () =>
    withService({}, ({ service, sql, sourcePath, repo }) =>
      Effect.gen(function* () {
        const crypto = yield* Digest.Digest;
        const digest = yield* crypto
          .digest(Digest.sha256, new TextEncoder().encode(`t3x-import|thread|${T_STOPPED}`))
          .pipe(Effect.orDie);
        const targetRef = yield* checkpointRefForScopeOrdinal({
          scopeId: oldScopeId.replace(T_STOPPED, uuidFromDigest(digest)) as never,
          ordinalWithinScope: 0,
        });
        git(repo, ["commit", "-q", "--allow-empty", "-m", "continued in T3 Extend"]);
        git(repo, ["update-ref", targetRef, "HEAD"]);
        const sourceBefore = yield* hashFile(sourcePath);
        const refsBefore = git(repo, ["for-each-ref"]);

        const report = yield* service.check(
          selectionOf({ threadIds: [ThreadId.make(T_STOPPED)], scheduledTasks: [], files: [] }),
        );

        assert.deepStrictEqual(
          report.attention.filter((notice) => notice.code === "checkpoint-refs-conflict"),
          [{ code: "checkpoint-refs-conflict", subject: "", count: 1 }],
        );
        assert.notInclude(codes(report.fixed), "checkpoint-refs-copied");
        assert.equal(git(repo, ["for-each-ref"]), refsBefore);
        assert.equal(yield* hashFile(sourcePath), sourceBefore);
        const [bookkeeping] = yield* sql<{
          count: number;
        }>`SELECT (SELECT COUNT(*) FROM fork_t3code_import_map) + (SELECT COUNT(*) FROM fork_t3code_import_runs) AS count`;
        assert.equal(bookkeeping?.count, 0);
      }),
    ),
  );

  it.effect(
    "shares a thread's worktree with the running server the moment the import marks it",
    () =>
      withService({}, ({ service, config, home, repo }) =>
        Effect.gen(function* () {
          const policy = yield* SharedWorktrees.SharedWorktreePolicy;
          const worktree = `${home}/worktrees/kept/feature`;
          const refusal = () =>
            policy
              .refusal({ cwd: repo, path: worktree })
              .pipe(Effect.provideService(ServerConfig.ServerConfig, config));
          assert.isNull(yield* refusal());
          yield* runToEnd(
            service,
            selectionOf({ threadIds: [ThreadId.make(T_STOPPED)], scheduledTasks: [], files: [] }),
          );
          assert.isString(yield* refusal());
        }),
      ),
  );

  {
    const selection = () =>
      selectionOf({
        threadIds: [ThreadId.make(T_STOPPED), ThreadId.make(T_SOLO)],
        scheduledTasks: [],
        files: [],
      });
    const lastState = (service: T3CodeImport.T3CodeImport["Service"]) =>
      Effect.gen(function* () {
        yield* service.start(selection());
        const last = yield* service.state.pipe(
          Stream.filter((state) => state.status === "finished" || state.status === "failed"),
          Stream.runHead,
        );
        return Option.getOrThrow(last);
      });
    const count = (sql: SqlClient.SqlClient, table: string, where = "1 = 1") =>
      sql
        .unsafe<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
        .pipe(Effect.map((rows) => Number(rows[0]!.count)));
    const worktreesOf = (home: string) => [
      `${home}/worktrees/kept/feature`,
      `${home}/worktrees/gone`,
    ];
    const refused = (home: string, repo: string, config: ServerConfig.ServerConfig["Service"]) =>
      Effect.gen(function* () {
        const policy = yield* SharedWorktrees.SharedWorktreePolicy;
        return yield* Effect.forEach(worktreesOf(home), (worktree) =>
          policy.refusal({ cwd: repo, path: worktree }).pipe(
            Effect.provideService(ServerConfig.ServerConfig, config),
            Effect.map((reason) => reason !== null),
          ),
        );
      });

    it.effect("marks every selected worktree, in memory first, before the first thread row", () => {
      const markCalls: Array<number> = [];
      return withService({ markCalls }, ({ service, sql }) =>
        Effect.gen(function* () {
          yield* sql`CREATE TABLE order_log (markers INTEGER)`;
          yield* sql`CREATE TRIGGER log_markers BEFORE INSERT ON orchestration_v2_projection_threads
            BEGIN INSERT INTO order_log SELECT COUNT(*) FROM fork_t3code_import_map WHERE kind = 'worktree'; END`;
          assert.equal((yield* lastState(service)).status, "finished");
          // Memory is marked while the database holds nothing yet, and the database holds both
          // worktrees by the time the first thread row is written.
          assert.deepStrictEqual(markCalls, [0]);
          const seen = yield* sql<{ markers: number }>`SELECT markers FROM order_log`;
          assert.isAbove(seen.length, 1);
          assert.isTrue(seen.every((row) => row.markers === 2));
        }),
      );
    });

    it.effect(
      "a failed marker write commits no thread, and a resumed run marks the same rows once",
      () =>
        withService({}, ({ service, sql, home, repo, config }) =>
          Effect.gen(function* () {
            yield* sql`CREATE TRIGGER refuse_markers BEFORE INSERT ON fork_t3code_import_map
            WHEN NEW.kind = 'worktree' BEGIN SELECT RAISE(ABORT, 'markers unavailable'); END`;
            assert.equal((yield* lastState(service)).status, "failed");
            assert.equal(yield* count(sql, "orchestration_v2_projection_threads"), 0);
            // Memory was marked first, so the worktrees are protected even though the database is not.
            assert.deepStrictEqual(yield* refused(home, repo, config), [true, true]);

            yield* sql`DROP TRIGGER refuse_markers`;
            assert.equal((yield* lastState(service)).status, "finished");
            assert.equal(yield* count(sql, "fork_t3code_import_map", "kind = 'worktree'"), 2);
            assert.equal(yield* count(sql, "orchestration_v2_projection_threads"), 2);
            // Running it all again repeats nothing.
            assert.equal((yield* lastState(service)).status, "finished");
            assert.equal(yield* count(sql, "fork_t3code_import_map", "kind = 'worktree'"), 2);
          }),
        ),
    );

    it.effect("an import that stops after its first thread leaves every worktree protected", () =>
      withService({}, ({ service, sql, home, repo, config }) =>
        Effect.gen(function* () {
          yield* sql`CREATE TRIGGER stop_after_first BEFORE INSERT ON orchestration_v2_projection_threads
            WHEN (SELECT COUNT(*) FROM orchestration_v2_projection_threads) >= 1
            BEGIN SELECT RAISE(ABORT, 'interrupted'); END`;
          assert.equal((yield* lastState(service)).status, "failed");
          assert.isAtLeast(yield* count(sql, "orchestration_v2_projection_threads"), 1);
          assert.deepStrictEqual(yield* refused(home, repo, config), [true, true]);
          assert.equal(yield* count(sql, "fork_t3code_import_map", "kind = 'worktree'"), 2);
        }),
      ),
    );
  }

  it.effect("refuses to start without the server's shared-worktree policy", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        withService({ withoutSharedWorktreePolicy: true }, () => Effect.void),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("treats a ref that already holds the same commit as copied", () =>
    withService({}, ({ service, repo }) =>
      Effect.gen(function* () {
        const crypto = yield* Digest.Digest;
        const digest = yield* crypto
          .digest(Digest.sha256, new TextEncoder().encode(`t3x-import|thread|${T_STOPPED}`))
          .pipe(Effect.orDie);
        const targetRef = yield* checkpointRefForScopeOrdinal({
          scopeId: oldScopeId.replace(T_STOPPED, uuidFromDigest(digest)) as never,
          ordinalWithinScope: 0,
        });
        git(repo, ["update-ref", targetRef, "HEAD"]);
        const result = yield* runToEnd(
          service,
          selectionOf({
            threadIds: [ThreadId.make(T_STOPPED)],
            scheduledTasks: [],
            files: [],
          }),
        );
        assert.equal(
          result.report.fixed.find((notice) => notice.code === "checkpoint-refs-copied")?.count,
          1,
        );
        assert.notInclude(codes(result.report.attention), "checkpoint-refs-conflict");
        assert.equal(git(repo, ["rev-parse", targetRef]), git(repo, ["rev-parse", "HEAD"]));
      }),
    ),
  );

  it.effect(
    "rewrites every spelling of a thread id that needs encoding, scope and ref included",
    () =>
      withService({}, ({ service, sql, repo }) =>
        Effect.gen(function* () {
          const result = yield* runToEnd(
            service,
            selectionOf({
              threadIds: [ThreadId.make(T_COLON)],
              scheduledTasks: [],
              files: [],
            }),
          );
          assert.equal(result.importedThreads, 1);
          const [thread] = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM orchestration_v2_projection_threads`;
          const target = thread!.thread_id;
          assert.notEqual(target, T_COLON);

          const [scope] = yield* sql<{
            scope_id: string;
            payload_json: string;
          }>`SELECT scope_id, payload_json FROM orchestration_v2_projection_checkpoint_scopes`;
          assert.notEqual(scope?.scope_id, colonScopeId);
          assert.equal(
            scope?.scope_id,
            joinId("checkpoint-scope", "thread", target, "name", "root"),
          );

          const [checkpoint] = yield* sql<{
            checkpoint_id: string;
            status: string;
            payload_json: string;
          }>`SELECT checkpoint_id, status, payload_json FROM orchestration_v2_projection_checkpoints`;
          const sourceRef = yield* checkpointRefForScopeOrdinal({
            scopeId: colonScopeId as never,
            ordinalWithinScope: 0,
          });
          const importedRef = (JSON.parse(checkpoint!.payload_json) as { ref: string }).ref;
          assert.notEqual(importedRef, sourceRef);
          assert.equal(checkpoint?.status, "ready");
          // The copy resolves, and it is the commit the original names.
          assert.equal(git(repo, ["rev-parse", importedRef]), git(repo, ["rev-parse", sourceRef]));
          // The scope the ref name derives from is the imported one.
          assert.equal(
            importedRef,
            yield* checkpointRefForScopeOrdinal({
              scopeId: scope!.scope_id as never,
              ordinalWithinScope: 0,
            }),
          );
          assert.deepStrictEqual(yield* sourceIdsLeft(sql, [T_COLON, P_SOLO]), []);
        }),
      ),
  );

  it.effect("leaves no official id behind when a thread's subagents stay out", () =>
    withService({}, ({ service, sql }) =>
      Effect.gen(function* () {
        const result = yield* runToEnd(
          service,
          selectionOf({
            threadIds: [ThreadId.make(T_PARENT)],
            includeSubagents: false,
            scheduledTasks: [],
            files: [],
          }),
        );
        assert.equal(result.importedThreads, 1);
        assert.include(codes(result.report.attention), "subagents-omitted");
        // The card stays but opens nothing; the hand-off to the subagent is dropped.
        const [card] = yield* sql<{
          child_thread_id: string | null;
          child: string | null;
        }>`SELECT child_thread_id, json_extract(payload_json, '$.childThreadId') AS child FROM orchestration_v2_projection_subagents`;
        assert.deepStrictEqual(card, { child_thread_id: null, child: null });
        const [transfers] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_context_transfers`;
        assert.equal(transfers?.count, 0);
        assert.deepStrictEqual(yield* sourceIdsLeft(sql, [T_PARENT, T_SUB, P_KEPT]), []);
      }),
    ),
  );

  it.effect("gives an imported signed webhook task a new signing secret and shows it once", () =>
    withService({}, ({ service, sql, captured }) =>
      Effect.gen(function* () {
        const result = yield* runToEnd(
          service,
          selectionOf({
            threadIds: [],
            scheduledTasks: [{ taskId: TASK_SIGNED, enabled: true }],
            files: [],
          }),
        );
        const schedule = captured.tasks[0]?.schedule as {
          signature: { secret: string };
        };
        assert.isString(schedule.signature.secret);
        assert.notEqual(schedule.signature.secret, "secret"); // the official app's value
        assert.deepStrictEqual(
          result.report.attention
            .filter((notice) => notice.code.startsWith("task-webhook"))
            .map((notice) => [notice.code, notice.detail?.startsWith("/api/hooks/") ?? false]),
          [
            ["task-webhook-url", true],
            ["task-webhook-secret", false],
          ],
        );
        assert.equal(
          result.report.attention.find((notice) => notice.code === "task-webhook-secret")?.detail,
          schedule.signature.secret,
        );
        const [run] = yield* sql<{
          summary_json: string;
        }>`SELECT summary_json FROM fork_t3code_import_runs ORDER BY run_id DESC LIMIT 1`;
        assert.notInclude(run!.summary_json, schedule.signature.secret);
      }),
    ),
  );

  /** The official app carries on with a thread: one more event, one more message, a newer update time. */
  const continueInOfficial = (sourcePath: string, threadId: string, text = "followup") =>
    withDatabase(
      sourcePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [top] = yield* sql<{
          v: number;
        }>`SELECT MAX(stream_version) AS v FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}`;
        const next = (top?.v ?? -1) + 1;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
          VALUES (${`official-${threadId}-${next}`}, 'thread', ${threadId}, ${next}, 'run.created', '2026-10-01', 'user', '{}', '{}', 2)`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
          VALUES (${`message:${threadId}:${next}`}, ${threadId}, ${`run:thread:${threadId}:ordinal:1`}, 'user', 0, '2026-10-01', '2026-10-01', ${JSON.stringify({ text })})`;
        yield* sql`UPDATE orchestration_v2_projection_threads SET updated_at = '2026-10-01' WHERE thread_id = ${threadId}`;
      }),
    );

  const targetOf = (sql: SqlClient.SqlClient, sourceId: string) =>
    sql<{ target_id: string }>`SELECT target_id FROM fork_t3code_import_map
      WHERE kind = 'thread' AND source_id = ${sourceId}`.pipe(
      Effect.map((rows) => rows[0]!.target_id),
    );

  /** You carry on with an imported thread inside T3 Extend: one more run and message after the import. */
  const continueInExtend = Effect.fn("continueInExtend")(function* (
    sql: SqlClient.SqlClient,
    sourceId: string,
  ) {
    const target = yield* targetOf(sql, sourceId);
    const [top] = yield* sql<{
      v: number;
    }>`SELECT MAX(stream_version) AS v FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${target}`;
    const next = (top?.v ?? -1) + 1;
    yield* sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES (${`extend-${target}-${next}`}, 'thread', ${target}, ${next}, 'run.created', '2999-01-01', 'user', '{}', '{}', 2)`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${`extend-message:${target}`}, ${target}, ${`run:thread:${target}:ordinal:1`}, 'user', 0, '2999-01-01', '2999-01-01', '{"text":"typed in Extend"}')`;
    return target;
  });

  const stateOfThread = (service: T3CodeImport.T3CodeImport["Service"], threadId: string) =>
    Effect.gen(function* () {
      const catalog = yield* service.preview;
      assert.equal(catalog.status, "available");
      if (catalog.status !== "available") return undefined;
      return catalog.projects
        .flatMap((project) => project.threads)
        .find((thread) => thread.threadId === threadId);
    });

  const onlyThread = (threadId: string) =>
    selectionOf({ threadIds: [ThreadId.make(threadId)], scheduledTasks: [], files: [] });

  it.effect("offers an imported thread again once T3 Code has carried on with it", () =>
    withService({}, ({ service, sourcePath }) =>
      Effect.gen(function* () {
        yield* runToEnd(service, onlyThread(T_STOPPED));
        const before = yield* stateOfThread(service, T_STOPPED);
        assert.equal(before?.state, "imported");
        yield* continueInOfficial(sourcePath, T_STOPPED);
        const after = yield* stateOfThread(service, T_STOPPED);
        assert.equal(after?.state, "updated");
        assert.equal(after?.localChanges, 0);
        // Other imported threads that did not change stay put.
        yield* runToEnd(service, onlyThread(T_SOLO));
        assert.equal((yield* stateOfThread(service, T_SOLO))?.state, "imported");
      }),
    ),
  );

  it.effect("a subagent that moved on makes its parent's entry updated", () =>
    withService({}, ({ service, sourcePath }) =>
      Effect.gen(function* () {
        yield* runToEnd(service, onlyThread(T_PARENT));
        assert.equal((yield* stateOfThread(service, T_PARENT))?.state, "imported");
        yield* continueInOfficial(sourcePath, T_SUB);
        assert.equal((yield* stateOfThread(service, T_PARENT))?.state, "updated");
      }),
    ),
  );

  it.effect(
    "importing an updated thread again replaces the copy under the same id and tells live clients",
    () => {
      const announced: Array<string> = [];
      return withService({ announced }, ({ service, sql, sourcePath }) =>
        Effect.gen(function* () {
          yield* runToEnd(service, onlyThread(T_STOPPED));
          const target = yield* targetOf(sql, T_STOPPED);
          announced.length = 0;
          yield* continueInOfficial(sourcePath, T_STOPPED, "brand new words");
          const sourceBefore = yield* hashFile(sourcePath);

          const again = yield* runToEnd(service, onlyThread(T_STOPPED));

          assert.equal(again.importedThreads, 1);
          assert.equal(again.existingThreads, 0);
          assert.include(codes(again.report.fixed), "thread-refreshed");
          assert.notInclude(codes(again.report.fixed), "thread-ids-renewed");
          assert.equal(yield* targetOf(sql, T_STOPPED), target);
          const threads = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM orchestration_v2_projection_threads`;
          assert.deepStrictEqual(
            threads.map((row) => row.thread_id),
            [target],
          );
          const messages = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_messages
            WHERE thread_id = ${target} ORDER BY created_at`;
          assert.equal(messages.length, 2);
          assert.include(messages[1]!.payload_json, "brand new words");
          const [events] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${target}`;
          assert.equal(events?.count, 4);
          assert.deepStrictEqual(yield* sourceIdsLeft(sql, [T_STOPPED]), []);
          assert.equal((yield* stateOfThread(service, T_STOPPED))?.state, "imported");
          assert.equal(yield* hashFile(sourcePath), sourceBefore);
          assert.deepStrictEqual(announced, [target]);
        }),
      );
    },
  );

  it.effect(
    "an updated thread that nobody touched in T3 Extend is not flagged for discarding",
    () =>
      withService({}, ({ service, sourcePath }) =>
        Effect.gen(function* () {
          yield* runToEnd(service, onlyThread(T_STOPPED));
          yield* continueInOfficial(sourcePath, T_STOPPED);
          const report = yield* service.check(onlyThread(T_STOPPED));
          assert.include(codes(report.fixed), "thread-refreshed");
          assert.notInclude(codes(report.attention), "thread-local-discarded");
        }),
      ),
  );

  it.effect("warns before replacing what you wrote in T3 Extend, and only then does it", () =>
    withService({}, ({ service, sql, sourcePath }) =>
      Effect.gen(function* () {
        yield* runToEnd(service, onlyThread(T_STOPPED));
        const target = yield* continueInExtend(sql, T_STOPPED);
        // Only T3 Extend moved on: nothing to import, nothing to lose.
        assert.equal((yield* stateOfThread(service, T_STOPPED))?.state, "imported");
        yield* continueInOfficial(sourcePath, T_STOPPED);
        const entry = yield* stateOfThread(service, T_STOPPED);
        assert.equal(entry?.state, "updated");
        assert.equal(entry?.localChanges, 1);

        const report = yield* service.check(onlyThread(T_STOPPED));
        assert.deepStrictEqual(
          report.attention.filter((notice) => notice.code === "thread-local-discarded"),
          [{ code: "thread-local-discarded", subject: entry!.title, count: 1 }],
        );
        // Checking writes nothing.
        const [untouched] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_events
          WHERE stream_id = ${target} AND event_type = 'run.created'`;
        assert.equal(untouched?.count, 1);

        const again = yield* runToEnd(service, onlyThread(T_STOPPED));
        assert.equal(again.importedThreads, 1);
        const [gone] = yield* sql<{ count: number }>`SELECT
          (SELECT COUNT(*) FROM orchestration_v2_projection_messages WHERE message_id LIKE 'extend-message:%') +
          (SELECT COUNT(*) FROM orchestration_events WHERE event_id LIKE 'extend-%') AS count`;
        assert.equal(gone?.count, 0);
        assert.deepStrictEqual(
          codes(again.report.attention).filter((code) => code === "thread-local-discarded"),
          ["thread-local-discarded"],
        );
      }),
    ),
  );

  it.effect("never replaces a thread that is running or queued in T3 Extend", () =>
    withService({}, ({ service, sql, sourcePath }) =>
      Effect.gen(function* () {
        yield* runToEnd(service, onlyThread(T_STOPPED));
        const target = yield* targetOf(sql, T_STOPPED);
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'queued' WHERE thread_id = ${target}`;
        yield* continueInOfficial(sourcePath, T_STOPPED);

        const report = yield* service.check(onlyThread(T_STOPPED));
        assert.include(codes(report.skipped), "thread-target-busy");
        assert.notInclude(codes(report.fixed), "thread-refreshed");
        const again = yield* runToEnd(service, onlyThread(T_STOPPED));
        assert.equal(again.importedThreads, 0);
        assert.include(codes(again.report.skipped), "thread-target-busy");
        const [events] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${target}`;
        assert.equal(events?.count, 3);
      }),
    ),
  );

  it.effect("keeps skipping a thread that is busy in T3 Code even when it has updates", () =>
    withService({}, ({ service, sql }) =>
      Effect.gen(function* () {
        const report = yield* service.check(onlyThread(T_RUNNING));
        assert.include(codes(report.skipped), "thread-busy");
        const [rows] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM fork_t3code_import_map`;
        assert.equal(rows?.count, 0);
      }),
    ),
  );

  it.effect("still never moves a checkpoint ref when an updated thread is imported again", () =>
    withService({}, ({ service, sql, sourcePath, repo }) =>
      Effect.gen(function* () {
        yield* runToEnd(service, onlyThread(T_STOPPED));
        const [checkpoint] = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_checkpoints`;
        const copiedRef = (JSON.parse(checkpoint!.payload_json) as { ref: string }).ref;
        git(repo, ["commit", "-q", "--allow-empty", "-m", "moved on"]);
        git(repo, ["update-ref", copiedRef, "HEAD"]);
        const moved = git(repo, ["rev-parse", copiedRef]);
        yield* continueInOfficial(sourcePath, T_STOPPED);

        const report = yield* service.check(onlyThread(T_STOPPED));
        assert.deepStrictEqual(
          report.attention.filter((notice) => notice.code === "checkpoint-refs-conflict"),
          [{ code: "checkpoint-refs-conflict", subject: "", count: 1 }],
        );
        const again = yield* runToEnd(service, onlyThread(T_STOPPED));
        assert.include(codes(again.report.attention), "checkpoint-refs-conflict");
        assert.equal(git(repo, ["rev-parse", copiedRef]), moved);
        const [marked] = yield* sql<{
          status: string;
        }>`SELECT status FROM orchestration_v2_projection_checkpoints`;
        assert.equal(marked?.status, "missing");
      }),
    ),
  );

  it.effect("reads an import from before this feature by its time, not a recorded version", () =>
    withService({}, ({ service, sql, sourcePath }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-09-01T00:00:00Z"));
        yield* runToEnd(service, onlyThread(T_STOPPED));
        yield* sql`UPDATE fork_t3code_import_map SET source_version = NULL`;
        assert.equal((yield* stateOfThread(service, T_STOPPED))?.state, "imported");
        yield* continueInExtend(sql, T_STOPPED);
        assert.equal((yield* stateOfThread(service, T_STOPPED))?.state, "imported");
        yield* TestClock.setTime(Date.parse("2026-10-02T00:00:00Z"));
        yield* continueInOfficial(sourcePath, T_STOPPED);
        const entry = yield* stateOfThread(service, T_STOPPED);
        assert.equal(entry?.state, "updated");
        assert.equal(entry?.localChanges, 1);
      }),
    ),
  );
});
