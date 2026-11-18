import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatFileAttachment,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import { ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE } from "../../provider/antigravityAuthSupport.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  random: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.undefined,
});

function permissionRequest(
  toolCallId: string,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options,
    toolCall: { toolCallId, title: "Which branch?" },
  };
}

describe("AntigravityAdapterV2 flavor", () => {
  it("keeps a successful subagent launch running until the parent turn becomes idle", () => {
    const batch = flavor.extractSubagentUpdate?.({
      toolCallId: "trajectory:4",
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      data: { rawOutput: "Started two agents." },
    });
    assert.equal(batch?.status, "running");
    assert.equal(batch?.prompt, "Started two agents.");
    assert.isNull(batch?.result);
    assert.isTrue(flavor.subagentsIdleOnTurnCompletion);

    // Permission prompts carry the launch; later updates for the same call do not.
    const launch = flavor.extractSubagentUpdate?.({
      toolCallId: "35bea692fa95447fbdae6333fec5515f",
      title: "Run invoke_subagent?",
      kind: "other",
      status: "pending",
      data: {
        rawInput: {
          Subagents: [{ TypeName: "research", Role: "Readme Reader", Prompt: "Read README.md" }],
        },
      },
    });
    assert.equal(launch?.title, "Readme Reader");
    assert.equal(launch?.prompt, "Read README.md");
  });

  it("routes interaction_* permission requests to the question card", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_1", [
        { optionId: "main", name: "main", kind: "allow_once" },
        { optionId: "dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.isDefined(question);
    assert.deepEqual(
      question?.question.options.map((option) => option.label),
      ["main", "dev"],
    );
    assert.deepEqual(question?.respond({ interaction_1: "dev" }), {
      outcome: { outcome: "selected", optionId: "dev" },
    });
    assert.isUndefined(question?.respond({ interaction_1: "nope" }));
    assert.isUndefined(
      flavor.extractPermissionQuestion?.(
        permissionRequest("tool_1", [{ optionId: "allow", name: "Allow", kind: "allow_once" }]),
      ),
    );
  });

  it("keeps the question card to the agent's own options so a typed answer cannot be sent", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_2", [
        { optionId: "opt-main", name: "main", kind: "allow_once" },
        { optionId: "opt-dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.strictEqual(question?.question.allowCustomAnswer, false);
    assert.deepEqual(
      question?.question.options.map((option) => option.value),
      ["opt-main", "opt-dev"],
    );
    assert.deepEqual(question?.respond({ interaction_2: "opt-dev" }), {
      outcome: { outcome: "selected", optionId: "opt-dev" },
    });
  });
});

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

describe("AntigravityAdapterV2 compaction", () => {
  it.live.each([false, true])(
    "negotiates native goals (%s) without enabling manual compaction",
    (nativeGoals) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("antigravity-compaction-test");
        const goalSupport = yield* Ref.make(false);
        const startupMilestone = yield* Deferred.make<void>();
        const consumeStartupCommands = yield* Deferred.make<void>();
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1" },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime) => ({
                ...runtime,
                drainEvents: Deferred.succeed(startupMilestone, undefined).pipe(
                  Effect.andThen(runtime.drainEvents),
                ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
          supportsNativeGoals: Ref.get(goalSupport).pipe(
            Effect.tap(() => Deferred.succeed(startupMilestone, undefined)),
          ),
          onSessionEvent: (event) =>
            event._tag === "AvailableCommandsUpdated"
              ? Deferred.await(consumeStartupCommands).pipe(
                  Effect.andThen(Ref.set(goalSupport, nativeGoals)),
                )
              : Effect.void,
        });
        const opening = yield* adapter
          .openSession({
            threadId: ThreadId.make("thread-antigravity-compaction"),
            providerSessionId: ProviderSessionId.make("provider-session-antigravity-compaction"),
            modelSelection: { instanceId, model: "gemini-test-low" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
            }),
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(startupMilestone);
        yield* Deferred.succeed(consumeStartupCommands, undefined);
        const session = yield* Fiber.join(opening);
        assert.isUndefined(session.compactThread);
        assert.equal(session.providerSession.capabilities.turns.supportsNativeGoals, nativeGoals);
        assert.equal((yield* adapter.getCapabilities()).turns.supportsNativeGoals, nativeGoals);
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 session open", () => {
  it.effect.each([
    {
      name: "browser sign-in",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
        cause: undefined,
      }),
      requiresSignIn: true,
    },
    {
      name: "ACP authentication required",
      cause: EffectAcpErrors.AcpRequestError.authRequired(),
      requiresSignIn: true,
    },
    {
      name: "transport failure",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: "Connection closed",
        cause: undefined,
      }),
      requiresSignIn: undefined,
    },
  ] as const)("classifies $name during session open", ({ cause, requiresSignIn }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-sign-in-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: () => Effect.fail(cause),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-sign-in");
      const error = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-sign-in"),
          modelSelection: { instanceId, model: "gemini-test-low" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          }),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterOpenSessionError");
      assert.equal(
        error._tag === "ProviderAdapterOpenSessionError" && error.requiresSignIn,
        requiresSignIn,
      );
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 client file system", () => {
  it.effect("serves confined reads and leaves edits to the agent's diff tools", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      // effect-acp keeps the last handler registered per method; so does this.
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
      const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
      const requestLog = path.join(logs, "requests.ndjson");
      const crypto = yield* SecureRandom.SecureRandom;
      const instanceId = ProviderInstanceId.make("antigravity-containment-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_REQUEST_LOG_PATH: requestLog },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              handleWriteTextFile: (handler) =>
                Effect.sync(() => {
                  writeTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-outside-",
      });
      const outsideFile = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(outsideFile, "secret");
      const attachment = path.join(host.paths.attachmentsDir, "pasted.txt");
      yield* fileSystem.writeFileString(attachment, "pasted");

      const threadId = ThreadId.make("thread-antigravity-containment");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-containment"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      const initialize = (yield* fileSystem.readFileString(requestLog))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { clientCapabilities?: { fs?: unknown }; clientInfo?: { name?: string } };
            },
        )
        .find((request) => request.method === "initialize");
      assert.deepEqual(initialize?.params?.clientCapabilities?.fs, {
        readTextFile: true,
        writeTextFile: false,
      });
      assert.equal(initialize?.params?.clientInfo?.name, "zed");
      assert.isUndefined(writeTextFile);
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file reads");
      }
      const context = (method: string) => ({ requestId: `test-${method}`, method });

      const insidePath = path.join(workspace, "src", "inside.ts");
      yield* fileSystem.makeDirectory(path.dirname(insidePath), { recursive: true });
      yield* fileSystem.writeFileString(insidePath, "inside");
      const pasted = yield* readTextFile(
        { sessionId: "mock-session-1", path: attachment },
        context("fs/read_text_file"),
      );
      assert.equal(pasted.content, "pasted");
      yield* fileSystem.writeFileString(insidePath, "\uFEFFfirst\né中🙂\nlast");
      const sliced = yield* readTextFile(
        { sessionId: "mock-session-1", path: insidePath, line: 2, limit: 1 },
        context("fs/read_text_file"),
      );
      assert.equal(sliced.content, "é中🙂");
      yield* fileSystem.writeFileString(insidePath, "inside");
      for (const [name, bytes] of [
        ["image.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        ["data.bin", new Uint8Array([0x61, 0, 0x62])],
      ] as const) {
        const binaryPath = path.join(workspace, name);
        yield* fileSystem.writeFile(binaryPath, bytes);
        const binaryRead = yield* readTextFile(
          { sessionId: "mock-session-1", path: binaryPath },
          context("fs/read_text_file"),
        ).pipe(Effect.flip);
        assert.propertyVal(binaryRead, "code", -32602, `${name} is refused as binary`);
      }

      const outsideRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: outsideFile },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideRead));
      const linkPath = path.join(workspace, "linked-secret.txt");
      yield* fileSystem.symlink(outsideFile, linkPath);
      const linkedRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: linkPath },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(linkedRead), "a read through an escaping symlink is denied");
      const insideLink = path.join(workspace, "inside-link.ts");
      yield* fileSystem.symlink(insidePath, insideLink);
      const viaInsideLink = yield* readTextFile(
        { sessionId: "mock-session-1", path: insideLink },
        context("fs/read_text_file"),
      );
      assert.equal(viaInsideLink.content, "inside");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 workspace changes", () => {
  it.effect("confines file requests to the workspace of the turn in progress", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
      const host = yield* ProviderHost.ProviderHost;
      const document = ChatFileAttachment.make({
        type: "file",
        id: "native-pdf",
        name: "diagram.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
      });
      const documentPath = host.resolveAttachmentPath(document)!;
      yield* fileSystem.writeFileString(documentPath, "%PDF-1.7");
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-workspace-change-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              prompt: (request) =>
                Deferred.succeed(promptReceived, request).pipe(
                  Effect.andThen(runtime.prompt(request)),
                ),
              start: () =>
                runtime.start().pipe(
                  Effect.map((started) => ({
                    ...started,
                    initializeResult: {
                      ...started.initializeResult,
                      agentCapabilities: {
                        ...started.initializeResult.agentCapabilities,
                        promptCapabilities: { image: true, audio: true, embeddedContext: true },
                      },
                    },
                  })),
                ),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspaceA = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-a-" });
      const workspaceB = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-b-" });
      yield* fileSystem.writeFileString(path.join(workspaceA, "a.txt"), "from a");
      yield* fileSystem.writeFileString(path.join(workspaceB, "b.txt"), "from b");
      const policyFor = (cwd: string) =>
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
      const threadId = ThreadId.make("thread-antigravity-workspace-change");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-workspace-change"),
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-antigravity-workspace-change"),
            title: "Antigravity workspace change",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceB,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-antigravity-workspace-change"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-antigravity-workspace-change"),
          rootNodeId: NodeId.make("node-antigravity-workspace-change"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-antigravity-workspace-change"),
            text: "read b.txt",
            attachments: [document],
          },
          modelSelection,
          runtimePolicy: policyFor(workspaceB),
        })
        .pipe(Effect.forkScoped);
      yield* session.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      const sent = yield* Deferred.await(promptReceived);
      assert.deepEqual(
        sent.prompt.filter((block) => block.type === "resource_link"),
        [
          {
            type: "resource_link",
            uri: (yield* path.toFileUrl(documentPath)).href,
            name: "diagram.pdf",
            mimeType: "application/pdf",
            size: 8,
          },
        ],
      );
      assert.include(JSON.stringify(sent.prompt), JSON.stringify(documentPath).slice(1, -1));
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file requests");
      }
      const context = { requestId: "test-read", method: "fs/read_text_file" };
      const fromB = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceB, "b.txt") },
        context,
      );
      assert.equal(fromB.content, "from b");
      const fromA = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceA, "a.txt") },
        context,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(fromA), "the previous workspace is no longer readable");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 html_render pages", () => {
  it.effect("shows the page html_render published when the agent reports only a summary", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-html-render-test");
      const threadId = ThreadId.make("thread-antigravity-html-render");
      const page = (name: string) => ({
        attachmentId: `${threadId}-${name}-html`,
        title: "Revenue",
        height: 240,
      });
      // Long enough that Antigravity bounds the html the adapter sees.
      const rows = Array.from({ length: 500 }, (_, row) => `<tr><td>Row ${row}</td></tr>`);
      const report = { html: `<table>${rows.join("")}</table>`, title: "Revenue", height: 240 };
      const failed = { ...report, html: "<p>Revenue</p>" };
      const errored = { ...report, html: "<p>Revenue error</p>" };
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              // agy_acp_server 1.3/1.4 without a permission prompt: the call is
              // titled "Running <tool>" and completes with the step's summary
              // in place of the MCP result.
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate(
                          normalizeAntigravitySessionUpdate({
                            sessionId: "mock-session-1",
                            update,
                          }),
                        );
                  const calls = [
                    ["published", report],
                    ["unpublished", { ...report, html: "<p>Costs</p>" }],
                    ["failed", failed],
                    ["error", errored],
                  ] as const;
                  for (const [toolCallId, rawInput] of calls) {
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("report"));
                  yield* mcpSessions.recordHtmlRender(threadId, failed, page("failed"));
                  yield* mcpSessions.recordHtmlRender(threadId, errored, page("error"));
                  for (const [toolCallId, status] of [
                    ["unpublished", "completed"],
                    ["failed", "failed"],
                    ["published", "completed"],
                    ["published", "completed"],
                  ] as const) {
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status,
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "error",
                    status: "completed",
                    rawOutput: { result: { isError: true, content: [] } },
                  });
                  for (const [name, rawInput] of [
                    ["failed", failed],
                    ["error", errored],
                  ] as const) {
                    const toolCallId = `${name}-retry`;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                    yield* mcpSessions.recordHtmlRender(threadId, rawInput, page(toolCallId));
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: name,
                      status: name === "failed" ? "failed" : "completed",
                      rawOutput:
                        name === "failed"
                          ? "Summary of failed"
                          : { result: { isError: true, content: [] } },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("replacement"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: { htmlRender: page("replacement") },
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: "Summary of published",
                  });
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-html-render"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-html-render"),
          title: "Antigravity html_render",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-html-render"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-html-render"),
        rootNodeId: NodeId.make("node-antigravity-html-render"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-html-render"),
          text: "chart the revenue",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const tool = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        if (event?.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool") {
          return undefined;
        }
        const item = event.turnItem;
        return {
          status: item.status,
          toolName: item.toolName,
          page: htmlRenderFromToolItem(item),
          output: item.output,
        };
      };

      assert.deepEqual(tool("published"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("replacement"),
        output: { htmlRender: page("replacement") },
      });
      assert.deepEqual(tool("unpublished"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of unpublished",
      });
      assert.deepEqual(tool("failed"), {
        status: "failed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of failed",
      });
      assert.deepEqual(tool("error"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: [],
      });
      assert.deepEqual(
        events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "published" &&
          event.turnItem.status === "completed"
            ? [htmlRenderFromToolItem(event.turnItem)]
            : [],
        ),
        [page("report"), page("report"), page("replacement"), page("replacement")],
      );
      for (const name of ["failed-retry", "error-retry"]) {
        assert.deepEqual(tool(name), {
          status: "completed",
          toolName: "t3-code.html_render",
          page: page(name),
          output: { htmlRender: page(name) },
        });
      }
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, report), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, failed), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, errored), undefined);
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 subagent reads", () => {
  it.effect("completes a read T3 served when the agent later fails it with a step error", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-outside-",
      });
      const served = path.join(workspace, "served.ts");
      yield* fileSystem.writeFileString(served, "export {};");
      const denied = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(denied, "secret");
      const unseen = path.join(workspace, "unseen.ts");
      const retried = path.join(workspace, "retried.ts");
      const stepError = 'Model produced invalid output. ("model output error")';
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-subagent-reads-test");
      const threadId = ThreadId.make("thread-antigravity-subagent-reads");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              // agy_acp_server announces a subagent's client_view_file on the parent session,
              // never completes it, then fails every open call with the next step error.
              prompt: () =>
                Effect.gen(function* () {
                  if (sessionUpdate === undefined || readTextFile === undefined) {
                    return yield* Effect.die("the adapter must handle updates and reads");
                  }
                  const send = sessionUpdate;
                  const handleRead = readTextFile;
                  const update = (update: EffectAcpSchema.SessionUpdate) =>
                    send(
                      normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }),
                    );
                  // The agent's own view_file never reaches T3, so it must not take a served read.
                  const reads = [
                    ["call_native", served, "Running view_file"],
                    ["call_served", served, "Running client_view_file"],
                    ["call_missing", retried, "Running client_view_file"],
                    ["call_retried", retried, "Running client_view_file"],
                    ["call_denied", denied, "Running client_view_file"],
                    ["call_unseen", unseen, "Running client_view_file"],
                  ] as const;
                  for (const [toolCallId, target, title] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title,
                      kind: "read",
                      status: "in_progress",
                      rawInput: { absolute_path: target },
                      locations: [{ path: target }],
                    });
                  }
                  const serve = (target: string) =>
                    handleRead(
                      { sessionId: "subagent-conversation", path: target },
                      { requestId: `read-${target}`, method: "fs/read_text_file" },
                    ).pipe(Effect.exit);
                  yield* serve(served);
                  yield* serve(retried);
                  yield* fileSystem.writeFileString(retried, "export {};").pipe(Effect.orDie);
                  yield* serve(retried);
                  yield* serve(denied);
                  for (const [toolCallId] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "failed",
                      rawOutput: stepError,
                    });
                  }
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-subagent-reads"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-subagent-reads"),
          title: "Antigravity subagent reads",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-subagent-reads"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-subagent-reads"),
        rootNodeId: NodeId.make("node-antigravity-subagent-reads"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-subagent-reads"),
          text: "review the codebase",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const read = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        return event?.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? { status: event.turnItem.status, output: event.turnItem.output }
          : undefined;
      };

      const firstEvent = (nativeId: string, status: string) =>
        events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId &&
            event.turnItem.status === status,
        );
      // T3 completes a served read itself instead of leaving it running until the flush.
      assert.isAbove(firstEvent("call_served", "completed"), -1);
      assert.isBelow(firstEvent("call_served", "completed"), firstEvent("call_native", "failed"));
      const failed = { status: "failed" as const, output: stepError };
      assert.deepEqual(read("call_served"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_retried"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_native"), failed);
      assert.deepEqual(read("call_missing"), failed);
      assert.deepEqual(read("call_denied"), failed);
      assert.deepEqual(read("call_unseen"), failed);
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 runtime mode ceiling", () => {
  const modesSetFor = (pickedMode: string) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const modesSet: Array<string> = [];
      const instanceId = ProviderInstanceId.make("antigravity-ceiling-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              setMode: (modeId) =>
                Effect.sync(() => {
                  modesSet.push(modeId);
                }).pipe(Effect.andThen(runtime.setMode(modeId))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-ceiling");
      yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-ceiling"),
        modelSelection: {
          instanceId,
          model: "gemini-test-low",
          options: [{ id: "_t3/session-mode", value: pickedMode }],
        },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: process.cwd(),
          maxRuntimeMode: "auto-accept-edits",
        }),
      });
      return modesSet;
    }).pipe(Effect.provide(layerSession), Effect.scoped);

  it.effect("does not apply a picked session mode above the policy ceiling", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* modesSetFor("yolo"), ["default"]);
      // A mode under the ceiling is still the user's to pick.
      assert.deepEqual(yield* modesSetFor("auto_edit"), ["default", "auto_edit"]);
    }),
  );
});

describe("AntigravityAdapterV2 session system prompt", () => {
  it.effect.each(["1.4.5", "1.4.1"])(
    "carries PR linking once in the %s session setup or once per turn",
    (agentVersion) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
        const requestLog = path.join(logs, "requests.ndjson");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
        const instanceId = ProviderInstanceId.make("antigravity-system-prompt-test");
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_AGENT_VERSION: agentVersion,
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                  T3_ACP_HANG_PROMPT_FOREVER: "1",
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                prompt: (request) =>
                  Deferred.succeed(promptReceived, request).pipe(
                    Effect.andThen(runtime.prompt(request)),
                  ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-sp-" });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const threadId = ThreadId.make("thread-antigravity-system-prompt");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-system-prompt"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session
          .startTurn({
            appThread: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project-antigravity-system-prompt"),
              title: "Antigravity system prompt",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            threadId,
            runId: RunId.make("run-antigravity-system-prompt"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("attempt-antigravity-system-prompt"),
            rootNodeId: NodeId.make("node-antigravity-system-prompt"),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-antigravity-system-prompt"),
              text: "open a PR",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        const sent = JSON.stringify((yield* Deferred.await(promptReceived)).prompt);
        const sessionNew = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { _meta?: unknown } })
          .find((request) => request.method === "session/new");
        const append = JSON.stringify(sessionNew?.params?._meta ?? null);
        // Identity stays per turn either way.
        assert.include(sent, "through the Antigravity harness, as gemini-test-low");
        if (agentVersion === "1.4.5") {
          assert.include(append, "pull_request_linking");
          assert.notInclude(sent, "<pull_request_linking>");
        } else {
          assert.notInclude(append, "systemPrompt");
          assert.include(sent, "<pull_request_linking>");
        }
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 background commands", () => {
  // Shapes recorded from agy 1.5.10 (gemini-3.8-flash): a run_command moved to a background task
  // stays in_progress when session/prompt returns, then completes under the same tool call id.
  const SESSION = "mock-session-1";
  const command = (toolCallId: string, commandLine: string) => {
    const input = {
      CommandLine: commandLine,
      IsDaemon: false,
      WaitMsBeforeAsync: 500,
      toolSummary: "Run background sleep command",
    };
    return {
      toolCallId,
      name: "run_command",
      args: input,
      kind: "execute" as const,
      title: commandLine,
      rawInput: input,
    };
  };
  const completed = (toolCallId: string, commandLine: string, output: string) =>
    ({
      sessionUpdate: "tool_call_update" as const,
      ...command(toolCallId, commandLine),
      status: "completed" as const,
      rawOutput: { output, exit_code: 0 },
      content: [{ type: "content" as const, content: { type: "text" as const, text: output } }],
    }) satisfies EffectAcpSchema.SessionUpdate;
  const permission = (toolCallId: string, commandLine: string) =>
    ({
      sessionId: SESSION,
      toolCall: { ...command(toolCallId, commandLine), status: "pending" as const },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" as const },
        { optionId: "deny", name: "Deny", kind: "reject_once" as const },
      ],
    }) satisfies EffectAcpSchema.RequestPermissionRequest;

  const setup = (runtimeMode: "approval-required" | "full-access") =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-background-",
      });
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const handlers: {
        update?: Parameters<RuntimeService["handleSessionUpdate"]>[0];
        permission?: Parameters<RuntimeService["handleRequestPermission"]>[0];
      } = {};
      const offered: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const offeredSignal = yield* Queue.unbounded<void>();
      let firstTurnUpdates: ReadonlyArray<EffectAcpSchema.SessionUpdate> = [];
      let promptHold: Deferred.Deferred<void> | undefined;
      let runtimeInput:
        | Parameters<Parameters<typeof makeAntigravityAdapterV2>[0]["makeRuntime"]>[0]
        | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-background-test");
      const threadId = ThreadId.make("thread-antigravity-background");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => offered.push(request)).pipe(
              Effect.andThen(Queue.offer(offeredSignal, undefined)),
              Effect.asVoid,
            ),
        },
        makeRuntime: (input) => {
          runtimeInput = input;
          return makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  handlers.update = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              handleRequestPermission: (handler) =>
                Effect.sync(() => {
                  handlers.permission = handler;
                }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
              prompt: () =>
                Effect.gen(function* () {
                  for (const update of firstTurnUpdates) {
                    yield* sendUpdate(update);
                  }
                  if (promptHold !== undefined) yield* Deferred.await(promptHold);
                  return { stopReason: "end_turn" as const };
                }),
            })),
          );
        },
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const sendUpdate = (update: EffectAcpSchema.SessionUpdate) =>
        handlers.update === undefined
          ? Effect.die("the adapter must handle updates")
          : handlers.update(normalizeAntigravitySessionUpdate({ sessionId: SESSION, update }));
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode,
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-background"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* session.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const startTurn = Effect.fnUntraced(function* (
        ordinal: number,
        message: {
          readonly createdBy: "user" | "agent";
          readonly creationSource: "web" | "provider";
          readonly text: string;
        },
      ) {
        const now = yield* DateTime.now;
        yield* session.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-antigravity-background"),
            title: "Antigravity background commands",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: workspace,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make(`run-antigravity-background-${ordinal}`),
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
          attemptId: RunAttemptId.make(`attempt-antigravity-background-${ordinal}`),
          rootNodeId: NodeId.make(`node-antigravity-background-${ordinal}`),
          providerThread,
          message: {
            ...message,
            messageId: MessageId.make(`message-antigravity-background-${ordinal}`),
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
      });
      // Collect events up to and including the first one that satisfies `until`.
      const collectUntil = Effect.fnUntraced(function* (
        until: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
      ) {
        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        while (true) {
          const event = yield* Queue.take(events);
          seen.push(event);
          if (until(event)) return seen;
        }
      });
      const toolItem = (
        seen: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
        nativeId: string,
      ) => {
        const event = seen.findLast(
          (candidate) =>
            candidate.type === "turn_item.updated" &&
            candidate.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        return event?.type === "turn_item.updated" ? event.turnItem : undefined;
      };
      return {
        handlers,
        acknowledgeResponse: (requestId: string) =>
          runtimeInput?.onOutgoingResponse?.(requestId) ?? Effect.void,
        offered,
        offeredSignal,
        startTurn,
        collectUntil,
        toolItem,
        sendUpdate,
        session,
        providerThread,
        setFirstTurnUpdates: (updates: ReadonlyArray<EffectAcpSchema.SessionUpdate>) => {
          firstTurnUpdates = updates;
        },
        // Keeps the next prompt open until the returned Deferred completes.
        holdPrompt: Effect.gen(function* () {
          promptHold = yield* Deferred.make<void>();
          return promptHold;
        }),
        // The update handler the current runtime installed; a restart replaces it.
        updateHandler: () => handlers.update,
      };
    });

  const isTerminal = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    event.type === "turn.terminal";

  it.effect(
    "keeps a command agy moved to the background running after the turn ends, then finishes it",
    () =>
      Effect.gen(function* () {
        const t = yield* setup("full-access");
        t.setFirstTurnUpdates([
          {
            sessionUpdate: "tool_call",
            ...command("call_A", "sleep 25; echo done-probe"),
            status: "in_progress",
          },
          { sessionUpdate: "tool_call_update", toolCallId: "call_A", status: "in_progress" },
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started" } },
        ]);
        yield* t.startTurn(1, {
          createdBy: "user",
          creationSource: "web",
          text: "run it in the background",
        });
        const first = yield* t.collectUntil(isTerminal);
        assert.equal(t.toolItem(first, "call_A")?.status, "running");

        yield* t.sendUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_A",
          status: "completed",
          rawOutput: {
            output: "Command exited with code 0.\n\nCommand output:\ndone-probe\r\n",
            exit_code: 0,
          },
        });
        const late = yield* t.collectUntil(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "call_A" &&
            event.turnItem.status === "completed",
        );
        assert.equal(t.toolItem(late, "call_A")?.status, "completed");
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "opens a continuation run for a permission request agy sends between turns and answers it there",
    () =>
      Effect.gen(function* () {
        const t = yield* setup("approval-required");
        t.setFirstTurnUpdates([
          {
            sessionUpdate: "tool_call",
            ...command("call_A", "sleep 20; echo first-probe"),
            status: "in_progress",
          },
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started" } },
        ]);
        yield* t.startTurn(1, {
          createdBy: "user",
          creationSource: "web",
          text: "run it in the background",
        });
        yield* t.collectUntil(isTerminal);
        yield* t.sendUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_A",
          status: "completed",
          rawOutput: {
            output: "Command exited with code 0.\n\nCommand output:\nfirst-probe\r\n",
            exit_code: 0,
          },
        });

        // The model's next step, 13 seconds after the prompt returned: a second command that needs approval.
        yield* t.sendUpdate({ sessionUpdate: "usage_update", used: 37710, size: 1048576 });
        yield* t.sendUpdate({
          sessionUpdate: "tool_call",
          ...command("call_B", "echo second-probe"),
          status: "in_progress",
        });
        yield* t.sendUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_B",
          status: "pending",
        });
        const requestPermission = t.handlers.permission;
        if (requestPermission === undefined) return yield* Effect.die("permission handler");
        const answer = yield* requestPermission(permission("call_B", "echo second-probe"), {
          requestId: "3",
          method: "session/request_permission",
        }).pipe(Effect.forkScoped);
        yield* Queue.take(t.offeredSignal);
        assert.lengthOf(t.offered, 1);
        assert.isUndefined(answer.pollUnsafe());

        yield* t.startTurn(2, {
          createdBy: "agent",
          creationSource: "provider",
          text: "Background task completed.",
        });
        const pending = yield* t.collectUntil(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        const request = pending.findLast((event) => event.type === "runtime_request.updated");
        if (request?.type !== "runtime_request.updated") return yield* Effect.die("approval");
        const responding = yield* t.session
          .respondToRuntimeRequest({ requestId: request.runtimeRequest.id, decision: "accept" })
          .pipe(Effect.forkScoped);
        const response = yield* Fiber.join(answer);
        assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "allow" } });
        yield* t.acknowledgeResponse("3");
        yield* Fiber.join(responding);

        yield* t.sendUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_B",
          status: "completed",
          rawOutput: {
            output: "Command exited with code 0.\n\nCommand output:\nsecond-probe\r\n",
            exit_code: 0,
          },
        });
        yield* t.sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "sixth-probe" },
        });
        // agy reports no end of prompt; the model step ending with no tool call after it is the signal.
        yield* t.sendUpdate({ sessionUpdate: "usage_update", used: 37800, size: 1048576 });
        yield* TestClock.adjust("2 seconds");
        const second = yield* t.collectUntil(isTerminal);
        assert.equal(t.toolItem(second, "call_B")?.status, "completed");
        const terminal = second.findLast(isTerminal);
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : null, "completed");
        assert.isTrue(
          second.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.role === "assistant" &&
              event.message.text.includes("sixth-probe"),
          ),
        );
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "Stop on a settled run cancels a request waiting for a continuation and blocks later wakes",
    () =>
      Effect.gen(function* () {
        const t = yield* setup("approval-required");
        t.setFirstTurnUpdates([
          {
            sessionUpdate: "tool_call",
            ...command("call_A", "sleep 20; echo first-probe"),
            status: "in_progress",
          },
        ]);
        yield* t.startTurn(1, { createdBy: "user", creationSource: "web", text: "go" });
        const first = yield* t.collectUntil(isTerminal);
        const turn = first.findLast((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") return yield* Effect.die("turn");
        const requestPermission = t.handlers.permission;
        if (requestPermission === undefined) return yield* Effect.die("permission handler");
        const answer = yield* requestPermission(permission("call_B", "echo second-probe"), {
          requestId: "3",
          method: "session/request_permission",
        }).pipe(Effect.forkScoped);
        yield* Queue.take(t.offeredSignal);
        yield* t.session.interruptTurn({
          providerThread: t.providerThread,
          providerTurnId: turn.providerTurn.id,
          requestRuntimeRestart: true,
        });
        assert.deepEqual(yield* Fiber.join(answer), { outcome: { outcome: "cancelled" } });
        yield* t.sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late words" },
        });
        assert.lengthOf(t.offered, 1);
        assert.isFalse(yield* t.session.hasPendingBackgroundWork!);
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "does not wake again once the user stopped the run, and cancels the waiting request",
    () =>
      Effect.gen(function* () {
        const t = yield* setup("approval-required");
        t.setFirstTurnUpdates([
          {
            sessionUpdate: "tool_call",
            ...command("call_A", "sleep 20; echo first-probe"),
            status: "in_progress",
          },
        ]);
        yield* t.startTurn(1, { createdBy: "user", creationSource: "web", text: "go" });
        yield* t.collectUntil(isTerminal);
        const requestPermission = t.handlers.permission;
        if (requestPermission === undefined) return yield* Effect.die("permission handler");
        const answer = yield* requestPermission(permission("call_B", "echo second-probe"), {
          requestId: "3",
          method: "session/request_permission",
        }).pipe(Effect.forkScoped);
        yield* Queue.take(t.offeredSignal);
        yield* t.startTurn(2, {
          createdBy: "agent",
          creationSource: "provider",
          text: "Background task completed.",
        });
        const pending = yield* t.collectUntil(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        const turn = pending.findLast((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") return yield* Effect.die("turn");
        yield* t.session.interruptTurn({
          providerThread: t.providerThread,
          providerTurnId: turn.providerTurn.id,
          requestRuntimeRestart: true,
        });
        assert.deepEqual(yield* Fiber.join(answer), { outcome: { outcome: "cancelled" } });
        // A late message from the agent must not start another run.
        yield* t.sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late words" },
        });
        assert.lengthOf(t.offered, 1);
        assert.isTrue(Option.isNone(yield* Queue.poll(t.offeredSignal)));
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
  type Setup = Effect.Success<ReturnType<typeof setup>>;
  const userMessage = (text: string) =>
    ({ createdBy: "user", creationSource: "web", text }) as const;
  const sleepsOpen = TestClock.testClockWith((clock) =>
    Effect.sync(() => (clock as unknown as { sleeps: ReadonlyArray<unknown> }).sleeps.length),
  );

  // agy ends a turn with a backgrounded command, the command finishes, and the model's next step
  // is a permission request: the continuation run is open and the card is waiting.
  const continuationAwaitingApproval = (t: Setup) =>
    Effect.gen(function* () {
      t.setFirstTurnUpdates([
        {
          sessionUpdate: "tool_call",
          ...command("call_A", "sleep 20; echo first-probe"),
          status: "in_progress",
        },
      ]);
      yield* t.startTurn(1, userMessage("go"));
      yield* t.collectUntil(isTerminal);
      yield* t.sendUpdate(
        completed(
          "call_A",
          "sleep 20; echo first-probe",
          "Command exited with code 0.\n\nCommand output:\nfirst-probe\r\n",
        ),
      );
      yield* t.sendUpdate({ sessionUpdate: "usage_update", used: 37710, size: 1048576 });
      yield* t.sendUpdate({
        sessionUpdate: "tool_call",
        ...command("call_B", "echo second-probe"),
        status: "in_progress",
      });
      yield* t.sendUpdate({
        sessionUpdate: "tool_call_update",
        ...command("call_B", "echo second-probe"),
        status: "pending",
      });
      const requestPermission = t.handlers.permission;
      if (requestPermission === undefined) return yield* Effect.die("permission handler");
      const answer = yield* requestPermission(permission("call_B", "echo second-probe"), {
        requestId: "3",
        method: "session/request_permission",
      }).pipe(Effect.forkScoped);
      yield* Queue.take(t.offeredSignal);
      yield* t.startTurn(2, {
        createdBy: "agent",
        creationSource: "provider",
        text: "Background task completed.",
      });
      const pending = yield* t.collectUntil(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const card = pending.findLast((event) => event.type === "runtime_request.updated");
      if (card?.type !== "runtime_request.updated") return yield* Effect.die("approval card");
      return { answer, request: card.runtimeRequest };
    });

  it.effect(
    "finishes a continuation whose approval was answered after its deadline and nothing followed",
    () =>
      Effect.gen(function* () {
        const t = yield* setup("approval-required");
        const { answer, request } = yield* continuationAwaitingApproval(t);
        // The card stays open past the idle deadline, which must not end the run under it.
        yield* TestClock.adjust("16 minutes");
        const responding = yield* t.session
          .respondToRuntimeRequest({ requestId: request.id, decision: "accept" })
          .pipe(Effect.forkScoped);
        assert.deepEqual(yield* Fiber.join(answer), {
          outcome: { outcome: "selected", optionId: "allow" },
        });
        yield* t.acknowledgeResponse("3");
        yield* Fiber.join(responding);
        // The agent says nothing more: the answer starts a fresh idle wait.
        yield* TestClock.adjust("16 minutes");
        const rest = yield* t.collectUntil(isTerminal);
        const terminal = rest.findLast(isTerminal);
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : null, "completed");
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect("closes the open approval card when Stop ends a continuation", () =>
    Effect.gen(function* () {
      const t = yield* setup("approval-required");
      const { answer, request } = yield* continuationAwaitingApproval(t);
      yield* t.session.interruptTurn({
        providerThread: t.providerThread,
        providerTurnId: request.providerTurnId!,
        requestRuntimeRestart: true,
      });
      assert.deepEqual(yield* Fiber.join(answer), { outcome: { outcome: "cancelled" } });
      const rest = yield* t.collectUntil(isTerminal);
      assert.isTrue(
        rest.some(
          (event) =>
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.id === request.id &&
            event.runtimeRequest.status === "cancelled",
        ),
      );
      assert.isTrue(
        rest.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "approval_request" &&
            event.turnItem.requestId === request.id &&
            event.turnItem.status === "cancelled",
        ),
      );
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect("stops the continuation's finish timer when the run ends", () =>
    Effect.gen(function* () {
      const t = yield* setup("approval-required");
      const { answer, request } = yield* continuationAwaitingApproval(t);
      const armed = yield* sleepsOpen;
      yield* t.session.interruptTurn({
        providerThread: t.providerThread,
        providerTurnId: request.providerTurnId!,
        requestRuntimeRestart: true,
      });
      yield* Fiber.join(answer);
      yield* t.collectUntil(isTerminal);
      assert.isBelow(yield* sleepsOpen, armed);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect("drops a late update from a run Stop ended once the next user turn is running", () =>
    Effect.gen(function* () {
      const t = yield* setup("approval-required");
      t.setFirstTurnUpdates([
        {
          sessionUpdate: "tool_call",
          ...command("call_A", "sleep 20; echo first-probe"),
          status: "in_progress",
        },
      ]);
      yield* t.startTurn(1, userMessage("go"));
      const first = yield* t.collectUntil(isTerminal);
      const turn = first.findLast((event) => event.type === "provider_turn.updated");
      if (turn?.type !== "provider_turn.updated") return yield* Effect.die("turn");
      yield* t.session.interruptTurn({
        providerThread: t.providerThread,
        providerTurnId: turn.providerTurn.id,
        requestRuntimeRestart: true,
      });
      const stale = t.updateHandler();
      if (stale === undefined) return yield* Effect.die("update handler");
      t.setFirstTurnUpdates([
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello again" } },
      ]);
      const release = yield* t.holdPrompt;
      yield* t.startTurn(2, userMessage("next message"));
      yield* t.collectUntil(
        (event) =>
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.text.includes("hello again"),
      );
      // The command Stop abandoned reports in, from the runtime Stop ended.
      yield* stale(
        normalizeAntigravitySessionUpdate({
          sessionId: SESSION,
          update: completed("call_A", "sleep 20; echo first-probe", "late output"),
        }),
      );
      yield* Deferred.succeed(release, undefined);
      const rest = yield* t.collectUntil(isTerminal);
      assert.isUndefined(t.toolItem(rest, "call_A"));
      assert.lengthOf(t.offered, 0);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "does not hand a command that finished inside WaitMsBeforeAsync to the detached path",
    () =>
      Effect.gen(function* () {
        const t = yield* setup("approval-required");
        t.setFirstTurnUpdates([
          {
            sessionUpdate: "tool_call",
            ...command("call_S", "echo sync"),
            status: "in_progress",
          },
          completed("call_S", "echo sync", "Command exited with code 0.\n\nsync\r\n"),
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
        ]);
        yield* t.startTurn(1, userMessage("go"));
        yield* t.collectUntil(isTerminal);
        yield* t.sendUpdate(completed("call_S", "echo sync", "late output"));
        t.setFirstTurnUpdates([]);
        const release = yield* t.holdPrompt;
        yield* t.startTurn(2, userMessage("next message"));
        const rest = yield* t.collectUntil(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        assert.isUndefined(t.toolItem(rest, "call_S"));
        yield* Deferred.succeed(release, undefined);
        yield* t.collectUntil(isTerminal);
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});
