// @effect-diagnostics nodeBuiltinImport:off - fixtures build a real git repository to prove ref copies.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type T3CodeImportSelection } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
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
import * as T3CodeImport from "./T3CodeImport.ts";

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
const TASK_INTERVAL = "scheduled-task:aaaa";
const TASK_WEBHOOK = "scheduled-task:bbbb";
const TASK_ORPHAN = "scheduled-task:cccc";
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
  const crypto = yield* Crypto.Crypto;
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
  void crypto;

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
          { worktreePath: path.join(home, "worktrees", "gone") },
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
      yield* sql`INSERT INTO ${sql("orchestration_v2_projection_checkpoint_scopes")}
        (scope_id, thread_id, run_id, node_id, parent_scope_id, provider_thread_id, kind, ordinal_within_parent, advances_app_run_count, created_at, payload_json)
        VALUES (${oldScopeId}, ${T_STOPPED}, ${`run:thread:${T_STOPPED}:ordinal:1`}, 'node', NULL, 'provider-thread', 'root_run', 0, 1, '2026-08-01',
          ${JSON.stringify({ id: oldScopeId, threadId: T_STOPPED, cwd: repo })})`;
      yield* sql`INSERT INTO ${sql("orchestration_v2_projection_checkpoints")}
        (checkpoint_id, thread_id, scope_id, run_id, node_id, parent_checkpoint_id, ordinal_within_scope, app_run_ordinal, status, captured_at, payload_json)
        VALUES (${`checkpoint:${T_STOPPED}:0`}, ${T_STOPPED}, ${oldScopeId}, NULL, 'node', NULL, 0, NULL, 'ready', '2026-08-01',
          ${JSON.stringify({ ref: oldRef, scopeId: oldScopeId, ordinalWithinScope: 0, status: "ready" })})`;
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
  options: { readonly sourceThroughMigration?: number },
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
    const mocks = Layer.mergeAll(
      OrchestrationEventStore.layer,
      ServerSettings.ServerSettingsService.layerTest(),
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
    const layer = T3CodeImport.layerWithSourceHome(home).pipe(
      Layer.provideMerge(mocks),
      Layer.provideMerge(NodeSqliteClient.layer({ filename: config.dbPath })),
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
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", yield* fs.readFile(file)).pipe(Effect.orDie);
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
            [true, false, true],
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
      withService({}, ({ service, sql }) =>
        Effect.gen(function* () {
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
          // The preflight reads only.
          const [rows] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`;
          assert.equal(rows?.count, 0);
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

          // Worktrees are shared: they stay where they are and cannot be removed from here.
          const worktree = path.join(home, "worktrees", "kept", "feature");
          const guard = yield* Effect.exit(
            service.assertWorktreeNotShared({ cwd: repo, path: worktree }),
          );
          assert.equal(guard._tag, "Failure");
          assert.isTrue(yield* fs.exists(worktree));
          yield* service.assertWorktreeNotShared({
            cwd: repo,
            path: path.join(home, "worktrees", "other"),
          });

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
    "migrates an older source on a private copy and leaves the official file as it was",
    () =>
      withService(
        { sourceThroughMigration: BUILD_MIGRATION_HEAD - 1 },
        ({ service, sql, sourcePath }) =>
          Effect.gen(function* () {
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
            assert.equal(yield* hashFile(sourcePath), before);
          }),
      ),
  );
});
