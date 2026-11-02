import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { BUILD_MIGRATION_HEAD } from "../persistence/databaseMigrationHead.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as T3CodeImport from "./T3CodeImport.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const projectId = ProjectId.make("project-kept");
const soloProjectId = ProjectId.make("project-solo");

const insertThread = Effect.fn("insertThread")(function* (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly runStatus: string;
  readonly payload: string;
  readonly updatedAt: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${input.threadId}, ${input.projectId}, ${input.threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${input.updatedAt}, ${input.payload})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES (${`run-${input.threadId}`}, ${input.threadId}, 1, 'codex', ${input.runStatus}, '2026-08-01', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages
    (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${`message-${input.threadId}`}, ${input.threadId}, ${`run-${input.threadId}`}, 'user', 0, '2026-08-01', '2026-08-01', '{"text":"hello"}')`;
  // The project id is embedded as text, the way real thread events carry it.
  yield* sql`INSERT INTO orchestration_events
    (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
    VALUES
    (${`created-${input.threadId}`}, 'thread', ${input.threadId}, 0, 'thread.created', '2026-08-01', 'user',
      ${JSON.stringify({ projectId: input.projectId })}, '{}', 2),
    (${`settled-${input.threadId}`}, 'thread', ${input.threadId}, 1, 'thread.settled', '2026-08-02', 'user',
      ${JSON.stringify({ projectId: input.projectId })}, '{}', 2)`;
});

/** A source home shaped like ~/.t3, built on a migrated database with realistic neighbours. */
const createSourceHome = Effect.fn("createSourceHome")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(home, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(path.join(stateDir, "attachments"), { recursive: true });
  yield* fs.writeFileString(path.join(stateDir, "attachments", "stopped-thread-photo.png"), "png");
  yield* fs.writeFileString(path.join(stateDir, "attachments", "running-thread-photo.png"), "png");
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-solo', 'Solo', '/tmp/solo', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES ('project-created-solo', 'project', 'project-solo', 0, 'project.created', '2026-08-01', 'user', '{}', '{}', 2)`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      for (const thread of [
        ["stopped-thread", "project-kept", "completed", "{}", "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "archived-thread",
          "project-kept",
          "completed",
          '{"archivedAt":"2026-08-01"}',
          "2026-08-05",
        ],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-thread", "project-kept", "completed", '{"deletedAt":"2026-08-03"}', "2026-08-05"],
        ["solo-thread", "project-solo", "completed", "{}", "2026-08-06"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
      ] as const) {
        yield* insertThread({
          threadId: thread[0],
          projectId: thread[1],
          runStatus: thread[2],
          payload: thread[3],
          updatedAt: thread[4],
        });
      }
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'archived-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
        VALUES ('command-1', 'thread', 'stopped-thread', '2026-08-01', 1, 'accepted')`;
      yield* sql`INSERT INTO orchestration_v2_command_receipts
        (command_id, thread_id, command_type, accepted_at, result_sequence, status)
        VALUES ('command-2', 'stopped-thread', 'thread.send', '2026-08-01', 1, 'accepted')`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
      yield* sql`INSERT INTO peer_environment_links
        (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
        VALUES ('environment-box', 'peer-link-box', 'Box', '["https://box.example"]', 'auto',
          '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

/** This environment's own database: migrated, with a project for /tmp/kept already added. */
const createTarget = Effect.fn("createTarget")(function* (baseDir: string) {
  const config = yield* ServerConfig.ServerConfig;
  yield* withDatabase(
    config.dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT OR IGNORE INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES ('project-here', 'Kept here', '/tmp/kept', '[]', '2026-09-01', '2026-09-01', NULL)`;
      yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_metadata
        (projection_name, schema_version, last_sequence, updated_at)
        VALUES ('thread-projections', 2, 0, '2026-09-01')`;
    }),
  );
  return baseDir;
});

const fixture = Effect.fn("fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-code-import-" });
  const sourceHome = path.join(root, "official");
  const baseDir = path.join(root, "extend");
  const sourcePath = yield* createSourceHome(sourceHome);
  return { sourceHome, sourcePath, baseDir };
});

const hashFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return NodeCrypto.createHash("sha256")
      .update(yield* fs.readFile(file))
      .digest("hex");
  });

/** Runs `use` against a live service whose database is `baseDir`'s, as the server would hold it. */
const withService = <A, E>(
  input: { readonly sourceHome: string; readonly baseDir: string },
  use: (
    service: T3CodeImport.T3CodeImport["Service"],
  ) => Effect.Effect<A, E, SqlClient.SqlClient | ServerConfig.ServerConfig>,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    yield* createTarget(input.baseDir);
    return yield* Effect.flatMap(T3CodeImport.T3CodeImport, use).pipe(
      Effect.provide(
        T3CodeImport.layerWithSourceHome(input.sourceHome).pipe(
          Layer.provide(OrchestrationEventStore.layer),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: config.dbPath })),
        ),
      ),
    );
  }).pipe(Effect.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), input.baseDir)));

it.layer(NodeServices.layer)("T3CodeImport", (it) => {
  it.effect(
    "previews what would come over: archived and settled threads, not busy or deleted ones",
    () =>
      Effect.gen(function* () {
        const { sourceHome, baseDir } = yield* fixture();
        const preview = yield* withService({ sourceHome, baseDir }, (service) => service.preview);

        assert.equal(preview.status, "available");
        if (preview.status !== "available") return;
        assert.deepStrictEqual(
          preview.projects
            .toSorted((a, b) => a.projectId.localeCompare(b.projectId))
            .map((project) => [
              project.projectId,
              project.importableThreads,
              project.busyThreads,
              project.joinsProjectId,
            ]),
          [
            // Same folder as project-here: its threads would join that project.
            [projectId, 4, 4, "project-here"],
            [soloProjectId, 1, 0, null],
          ],
        );
      }),
  );

  it.effect(
    "imports into the live database, skipping what must not cross over, and is idempotent",
    () =>
      Effect.gen(function* () {
        const { sourceHome, sourcePath, baseDir } = yield* fixture();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceHashBefore = yield* hashFile(sourcePath);

        const outcome = yield* withService({ sourceHome, baseDir }, (service) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const config = yield* ServerConfig.ServerConfig;
            const first = yield* service.run({ projectIds: [projectId, soloProjectId] });
            const afterFirst = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM orchestration_events`;
            const second = yield* service.run({ projectIds: [projectId, soloProjectId] });
            const afterSecond = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM orchestration_events`;

            const threads = yield* sql<{
              thread_id: string;
              project_id: string;
              payload_json: string;
            }>`
            SELECT thread_id, project_id, payload_json FROM orchestration_v2_projection_threads
            ORDER BY thread_id`;
            const events = yield* sql<{
              stream_id: string;
              stream_version: number;
              payload_json: string;
            }>`
            SELECT stream_id, stream_version, payload_json FROM orchestration_events
            WHERE aggregate_kind = 'thread' ORDER BY sequence`;
            const projectEvents = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events WHERE aggregate_kind = 'project'`;
            const projects = yield* sql<{ project_id: string }>`
            SELECT project_id FROM projection_projects ORDER BY project_id`;
            const [leftovers] = yield* sql<Record<string, number>>`
            SELECT
              (SELECT COUNT(*) FROM auth_sessions) AS auth,
              (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
              (SELECT COUNT(*) FROM orchestration_command_receipts) AS receipts,
              (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS receipts_v2,
              (SELECT COUNT(*) FROM peer_environment_links) AS links`;
            const [metadata] = yield* sql<{ last_sequence: number }>`
            SELECT last_sequence FROM orchestration_v2_projection_metadata`;
            const [newest] = yield* sql<{ sequence: number }>`
            SELECT MAX(sequence) AS sequence FROM orchestration_events
            WHERE application_event_version = 2 AND aggregate_kind = 'thread'`;
            const search = yield* sql<{ rowid: number }>`
            SELECT rowid FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH 'hello'`;
            const sessions = yield* sql<{ provider_session_id: string }>`
            SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`;
            const bindings = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings`;
            const transfers = yield* sql<{ context_transfer_id: string }>`
            SELECT context_transfer_id FROM orchestration_v2_projection_context_transfers`;
            const attachments = yield* fs.readDirectory(config.attachmentsDir);
            return {
              first,
              second,
              afterFirst,
              afterSecond,
              threads,
              events,
              projectEvents,
              projects,
              leftovers,
              metadata,
              newest,
              search,
              sessions,
              bindings,
              transfers,
              attachments,
            };
          }),
        );

        assert.deepStrictEqual(outcome.first, {
          importedProjects: 1,
          importedThreads: 5,
          existingThreads: 0,
          busyThreads: 4,
          copiedAttachments: 1,
        });
        // Nothing new on the second run; the busy threads are still busy.
        assert.deepStrictEqual(outcome.second, {
          importedProjects: 0,
          importedThreads: 0,
          existingThreads: 5,
          busyThreads: 4,
          copiedAttachments: 0,
        });
        assert.equal(outcome.afterFirst[0]?.count, outcome.afterSecond[0]?.count);

        assert.deepStrictEqual(
          outcome.threads.map((row) => [row.thread_id, row.project_id]),
          [
            ["archived-thread", "project-here"],
            ["fork-thread", "project-here"],
            ["settled-thread", "project-here"],
            ["solo-thread", "project-solo"],
            ["stopped-thread", "project-here"],
          ],
        );
        // The old project id is rewritten wherever it was embedded, so a rebuild stays consistent.
        assert.notInclude(JSON.stringify(outcome.events), "project-kept");
        assert.include(
          outcome.events.map((row) => row.payload_json),
          '{"projectId":"project-here"}',
        );
        assert.deepStrictEqual(
          outcome.events
            .filter((row) => row.stream_id === "stopped-thread")
            .map((row) => row.stream_version),
          [0, 1],
        );
        assert.deepStrictEqual(outcome.projectEvents, [{ stream_id: "project-solo" }]);
        assert.deepStrictEqual(
          outcome.projects.map((row) => row.project_id),
          ["project-here", "project-solo"],
        );

        assert.deepStrictEqual(outcome.leftovers, {
          auth: 0,
          tasks: 0,
          receipts: 0,
          receipts_v2: 0,
          links: 0,
        });
        assert.equal(outcome.metadata?.last_sequence, outcome.newest?.sequence);
        assert.equal(outcome.search.length, 5);
        // The shared session came with its one imported thread, not with the busy thread bound to it.
        assert.deepStrictEqual(outcome.sessions, [{ provider_session_id: "session-shared" }]);
        assert.deepStrictEqual(outcome.bindings, [{ thread_id: "stopped-thread" }]);
        assert.deepStrictEqual(outcome.transfers, [{ context_transfer_id: "transfer-1" }]);
        assert.deepStrictEqual(outcome.attachments, ["stopped-thread-photo.png"]);

        const attachmentSource = yield* fs.exists(
          path.join(sourceHome, "userdata", "attachments", "running-thread-photo.png"),
        );
        assert.isTrue(attachmentSource);
        assert.equal(yield* hashFile(sourcePath), sourceHashBefore);
      }),
  );

  it.effect("refuses a source that is missing, newer, older, or this very database", () =>
    Effect.gen(function* () {
      const { sourceHome, sourcePath, baseDir } = yield* fixture();
      const path = yield* Path.Path;
      const reasonOf = (home: string) =>
        withService({ sourceHome: home, baseDir }, (service) => service.preview).pipe(
          Effect.map((preview) =>
            preview.status === "unavailable" ? preview.reason : "available",
          ),
        );

      assert.equal(yield* reasonOf(path.join(sourceHome, "nowhere")), "source-missing");
      assert.equal(yield* reasonOf(path.join(baseDir)), "source-is-this-database");

      yield* withDatabase(
        sourcePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (999, 'FromTheFuture')`;
        }),
      );
      assert.equal(yield* reasonOf(sourceHome), "source-schema-newer");

      yield* withDatabase(
        sourcePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (999, ${BUILD_MIGRATION_HEAD})`;
        }),
      );
      assert.equal(yield* reasonOf(sourceHome), "source-schema-older");
    }),
  );
});
