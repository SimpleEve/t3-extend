// Drives the Pi adapter through omp's dialect against frames recorded from `omp --mode rpc` 18.20.2.
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
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import { OmpAdapterV2Driver } from "./adapter.ts";
import { OMP_PROVIDER } from "./dialect.ts";
import { type FakeOmp, makeFakeOmp } from "./fakeOmp.testkit.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const INSTANCE_ID = ProviderInstanceId.make("omp");
const THREAD_ID = ThreadId.make("thread-omp-test");
const SESSION_ID = ProviderSessionId.make("provider-session-omp-test");

const modelSelection = (model = "default"): ModelSelection => ({ instanceId: INSTANCE_ID, model });

const runtimePolicy = (runtimeMode: RuntimeMode) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
  });

const openRuntime = Effect.fnUntraced(function* (fake: FakeOmp, runtimeMode: RuntimeMode) {
  const adapter = yield* OmpAdapterV2Driver.create({
    instanceId: INSTANCE_ID,
    displayName: undefined,
    enabled: true,
    environment: [],
    config: { enabled: true, binaryPath: "omp", launchArgs: "--no-lsp", customModels: [] },
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
      offer: () => Effect.void,
      take: Effect.never,
    } as never),
  );
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy(runtimeMode),
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
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
    threadId: THREAD_ID,
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy(runtimeMode),
  });
  return { runtime, takeEvent, providerThread };
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  runtimeMode: RuntimeMode,
) {
  const now = yield* DateTime.now;
  const appThread = {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:omp" as OrchestrationV2AppThread["projectId"],
    title: "omp test thread",
    providerInstanceId: INSTANCE_ID,
    modelSelection: modelSelection(),
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
  const runId = RunId.make(`run:${THREAD_ID}:1`);
  yield* runtime.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${THREAD_ID}:1` as never,
      text: "Reply with exactly the single word: pong",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy(runtimeMode),
  });
});

const assistantMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "magpie",
  model: "auto/deepseek-v4.1-flash",
  usage: { input: 9418, output: 3, cacheRead: 128, cacheWrite: 0, totalTokens: 9549 },
  stopReason: "stop",
  ...extra,
});

/** The frames omp wrote for "Reply with exactly the single word: pong", message bodies trimmed. */
const pongTurn = (finalMessage = assistantMessage("pong")) => [
  { type: "thinking_level_changed", thinkingLevel: "low", configured: "auto", resolved: "low" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user" }, messageId: "msg-1" },
  { type: "message_end", message: { role: "user" }, messageId: "msg-1" },
  { type: "message_start", message: assistantMessage(""), messageId: "msg-2" },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    messageId: "msg-2",
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "p" },
    messageId: "msg-2",
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ong" },
    messageId: "msg-2",
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "pong" },
    messageId: "msg-2",
  },
  { type: "message_end", message: finalMessage, messageId: "msg-2" },
  { type: "turn_end", message: finalMessage },
];

const agentEnd = (finalMessage = assistantMessage("pong")) => [
  { type: "agent_end", messages: [finalMessage], yielded: true, isTerminal: true },
  {
    type: "prompt_result",
    id: "t3-prompt-0",
    agentInvoked: true,
    status: "completed",
    sessionSettled: true,
  },
  { type: "session_settled" },
];

describe("OmpAdapterV2", () => {
  it.effect("runs a turn through omp's RPC dialect and settles when the agent yields", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "full-access");
      assert.equal(providerThread.driver, OMP_PROVIDER);
      assert.equal(
        providerThread.nativeThreadRef?.nativeId,
        "/fake/.omp/agent/sessions/--workspace--/session-1.jsonl",
      );
      // T3's runtime mode and an ordinary launch argument both reach omp; the Pi extension does not.
      assert.deepEqual(fake.lastSpawnArgs(), [
        "--mode",
        "rpc",
        "--no-lsp",
        "--approval-mode",
        "yolo",
      ]);

      yield* startTurn(runtime, providerThread, "full-access");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "Reply with exactly the single word: pong");
      for (const frame of [...pongTurn(), ...agentEnd()]) yield* fake.emit(frame);

      const answer = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          !event.turnItem.streaming,
      );
      if (answer.type !== "turn_item.updated" || answer.turnItem.type !== "assistant_message") {
        return assert.fail("expected the assistant message");
      }
      assert.equal(answer.turnItem.text, "pong");
      assert.equal(answer.driver, OMP_PROVIDER);

      const completed = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.equal(completed.driver, OMP_PROVIDER);
      // The speed meter reads this: input counts cache reads, and nothing is shown without it.
      assert.deepEqual(
        completed.type === "provider_turn.updated" && completed.providerTurn.turnTokenUsage,
        {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 9418 + 128,
          outputTokens: 3,
          cachedInputTokens: 128,
        },
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails the turn when omp reports a provider error", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "full-access");
      yield* startTurn(runtime, providerThread, "full-access");
      yield* fake.takeRequest("prompt");
      const failed = assistantMessage("", {
        stopReason: "error",
        errorMessage: "429 rate limited",
      });
      for (const frame of [...pongTurn(failed), ...agentEnd(failed)]) yield* fake.emit(frame);
      const turn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" &&
          (event.providerTurn.status === "failed" || event.providerTurn.status === "completed"),
      );
      assert.equal(turn.type === "provider_turn.updated" && turn.providerTurn.status, "failed");
      assert.equal(
        turn.type === "provider_turn.updated" && turn.providerTurn.turnTokenUsage?.usageStatus,
        "partial",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "raises omp's approval prompt as an approval request and answers it in omp's words",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeOmp();
        const { runtime, takeEvent, providerThread } = yield* openRuntime(
          fake,
          "approval-required",
        );
        assert.deepEqual(fake.lastSpawnArgs().slice(-2), ["--approval-mode", "always-ask"]);
        yield* startTurn(runtime, providerThread, "approval-required");
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "tool_execution_start",
          toolCallId: "call_00_QFTnixzA3jRuMNkEApNy2299",
          toolName: "bash",
          args: { command: "echo omp-probe" },
          intent: "Running echo probe",
        });
        yield* fake.emit({
          type: "extension_ui_request",
          id: "15cfcc57317e7bcc",
          method: "select",
          title: "Allow tool: bash\nCommand: echo omp-probe",
          options: ["Approve", "Approve bash for this session", "Deny"],
        });

        const pending = yield* takeEvent(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        if (pending.type !== "runtime_request.updated") return assert.fail("expected a request");
        assert.equal(pending.runtimeRequest.nativeRequestRef?.nativeId, "15cfcc57317e7bcc");
        assert.equal(pending.runtimeRequest.kind, "command");

        yield* runtime.respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          decision: "accept",
        });
        const answered = yield* fake.takeRequest("extension_ui_response");
        assert.deepEqual(answered, {
          type: "extension_ui_response",
          id: "15cfcc57317e7bcc",
          value: "Approve",
        });

        yield* fake.emit({
          type: "extension_ui_request",
          id: "second",
          method: "select",
          title: "Allow tool: bash\nCommand: rm -rf build",
          options: ["Approve", "Approve bash for this session", "Deny"],
        });
        const second = yield* takeEvent(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        if (second.type !== "runtime_request.updated") return assert.fail("expected a request");
        yield* runtime.respondToRuntimeRequest({
          requestId: second.runtimeRequest.id,
          decision: "decline",
        });
        assert.equal((yield* fake.takeRequest("extension_ui_response"))["value"], "Deny");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("does not show extension status text, which clients label as Pi's", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent } = yield* openRuntime(fake, "full-access");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "s1",
        method: "setStatus",
        statusKey: "watch",
        statusText: "Watching 3 files",
      });
      // Frames are handled in order, so a dialog raised after the status proves it was handled.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "barrier",
        method: "confirm",
        title: "Continue?",
      });
      yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      assert.deepEqual(runtime.providerSession.extensionStatuses, []);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("stops a turn by withdrawing queued input and aborting", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp();
      const { runtime, takeEvent, providerThread } = yield* openRuntime(fake, "full-access");
      yield* startTurn(runtime, providerThread, "full-access");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const started = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      if (started.type !== "provider_turn.updated") return assert.fail("expected a running turn");
      yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
      yield* fake.takeRequest("abort_and_restore_queue");
      yield* fake.takeRequest("abort");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
