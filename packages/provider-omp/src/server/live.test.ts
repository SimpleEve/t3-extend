// @effect-diagnostics nodeBuiltinImport:off - A stub MCP server needs node:http, and the transcript goes to a file.
// Runs the adapter against the real omp binary and a real model, so CI skips it. To run it, point
// OMP_LIVE_AGENT_DIR at an omp agent directory (PI_CODING_AGENT_DIR) with a cheap default
// model, and optionally OMP_LIVE_LOG at a file that receives the event transcript:
//   OMP_LIVE_AGENT_DIR=/tmp/omp-agent vp test run packages/provider-omp/src/server/live.test.ts
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import { OmpAdapterV2Driver } from "./adapter.ts";

const AGENT_DIR = process.env["OMP_LIVE_AGENT_DIR"];
const LOG_FILE = process.env["OMP_LIVE_LOG"];
const OMP_BINARY = process.env["OMP_LIVE_BINARY"] ?? "omp";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const INSTANCE_ID = ProviderInstanceId.make("omp");
const modelSelection = (): ModelSelection => ({ instanceId: INSTANCE_ID, model: "default" });
const runtimePolicy = (runtimeMode: RuntimeMode) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
  });

const stubMcpServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly server: NodeHttp.Server;
        readonly endpoint: string;
        readonly calls: Array<unknown>;
      }>((resolve) => {
        const calls: Array<unknown> = [];
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => {
            const message = JSON.parse(body || "{}") as {
              id?: number;
              method?: string;
              params?: unknown;
            };
            if (message.id === undefined) {
              response.writeHead(202).end();
              return;
            }
            const result =
              message.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "task_status",
                        description: "Report the status of a delegated task by id",
                        inputSchema: {
                          type: "object",
                          properties: { taskId: { type: "string" } },
                          required: ["taskId"],
                        },
                      },
                    ],
                  }
                : message.method === "tools/call"
                  ? (calls.push(message.params),
                    { content: [{ type: "text", text: "status: running 42% (stub)" }] })
                  : {};
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          resolve({ server, endpoint: `http://127.0.0.1:${port}/mcp`, calls });
        });
      }),
  ),
  ({ server }) => Effect.sync(() => server.close()),
);

const openRuntime = Effect.fnUntraced(function* (
  runtimeMode: RuntimeMode,
  threadId: ThreadId,
  mcp?: { readonly endpoint: string },
) {
  const log = (line: unknown) =>
    LOG_FILE === undefined
      ? undefined
      : NodeFS.appendFileSync(LOG_FILE, `${JSON.stringify(line)}\n`);
  if (mcp !== undefined) {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.set({
      environmentId: "env-live" as never,
      threadId,
      providerSessionId: "provider-session-live",
      providerInstanceId: INSTANCE_ID,
      endpoint: mcp.endpoint,
      authorizationHeader: "Bearer live-token",
      browserToolsAvailable: false,
    });
  }
  const adapter = yield* OmpAdapterV2Driver.create({
    instanceId: INSTANCE_ID,
    displayName: undefined,
    enabled: true,
    environment: [],
    config: {
      enabled: true,
      binaryPath: OMP_BINARY,
      launchArgs: "--no-lsp --no-title",
      customModels: [],
    },
  }).pipe(
    Effect.provideService(HostProcess.Environment, {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      PI_CODING_AGENT_DIR: AGENT_DIR ?? "",
    }),
    Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
      offer: () => Effect.void,
      take: Effect.never,
    } as never),
  );
  const providerSessionId = ProviderSessionId.make(`provider-session-${threadId}`);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId,
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy(runtimeMode),
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => log(event)).pipe(Effect.andThen(Queue.offer(emitted, event))),
    ),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy(runtimeMode),
  });
  return { runtime, takeEvent, providerThread };
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  text: string,
) {
  const now = yield* DateTime.now;
  const appThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture:omp" as OrchestrationV2AppThread["projectId"],
    title: "omp live",
    providerInstanceId: INSTANCE_ID,
    modelSelection: modelSelection(),
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
  const runId = RunId.make(`run:${threadId}:1`);
  yield* runtime.startTurn({
    appThread,
    threadId,
    runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${threadId}:1` as never,
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy(runtimeMode),
  });
});

const turnDone = (event: ProviderAdapter.ProviderAdapterV2Event) =>
  event.type === "provider_turn.updated" &&
  event.providerTurn.status !== "running" &&
  event.providerTurn.status !== "pending";

describe.skipIf(AGENT_DIR === undefined)("omp live", () => {
  it.live("streams a plain turn and reports its token usage", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-omp-live-plain");
      const { runtime, takeEvent, providerThread } = yield* openRuntime("full-access", threadId);
      assert.isString(providerThread.nativeThreadRef?.nativeId);
      yield* startTurn(
        runtime,
        providerThread,
        threadId,
        "full-access",
        "Reply with exactly the single word: pong",
      );
      const done = yield* takeEvent(turnDone);
      if (done.type !== "provider_turn.updated") return assert.fail("expected a turn");
      assert.equal(done.providerTurn.status, "completed");
      const usage = done.providerTurn.tokenUsage;
      assert.isDefined(usage);
      assert.isAbove(usage?.usedTokens ?? 0, 0);
      assert.isAbove(usage?.maxTokens ?? 0, 0);
      assert.equal(done.providerTurn.turnTokenUsage?.usageStatus, "complete");
      assert.isAbove(done.providerTurn.turnTokenUsage?.outputTokens ?? 0, 0);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("asks before running a command in supervised mode and runs it once approved", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-omp-live-approval");
      const { runtime, takeEvent, providerThread } = yield* openRuntime(
        "approval-required",
        threadId,
      );
      yield* startTurn(
        runtime,
        providerThread,
        threadId,
        "approval-required",
        "Use the bash tool to run exactly: echo omp-live-probe . Then reply done.",
      );
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      if (pending.type !== "runtime_request.updated") return assert.fail("expected an approval");
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
      const command = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "command_execution" &&
          event.turnItem.status === "completed",
      );
      if (command.type !== "turn_item.updated" || command.turnItem.type !== "command_execution") {
        return assert.fail("expected a command");
      }
      assert.include(command.turnItem.output ?? "", "omp-live-probe");
      const done = yield* takeEvent(turnDone);
      assert.equal(done.type === "provider_turn.updated" && done.providerTurn.status, "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("lets the agent call T3's MCP tools as host tools", () =>
    Effect.gen(function* () {
      const mcp = yield* stubMcpServer;
      const threadId = ThreadId.make("thread-omp-live-host-tool");
      const { runtime, takeEvent, providerThread } = yield* openRuntime(
        "full-access",
        threadId,
        mcp,
      );
      yield* startTurn(
        runtime,
        providerThread,
        threadId,
        "full-access",
        "Call the tool mcp__t3-code__task_status with taskId 'abc' and tell me what it returned.",
      );
      const tool = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed",
      );
      if (tool.type !== "turn_item.updated" || tool.turnItem.type !== "dynamic_tool") {
        return assert.fail("expected a tool call");
      }
      assert.equal(tool.turnItem.toolName, "mcp__t3-code__task_status");
      assert.deepEqual(mcp.calls, [{ name: "task_status", arguments: { taskId: "abc" } }]);
      const done = yield* takeEvent(turnDone);
      assert.equal(done.type === "provider_turn.updated" && done.providerTurn.status, "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
