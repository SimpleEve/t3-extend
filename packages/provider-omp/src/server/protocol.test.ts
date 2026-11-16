// Frames below are trimmed from real `omp --mode rpc` 18.20.2 transcripts.
import { describe, expect, it } from "@effect/vitest";

import {
  makeOmpTranslator,
  type OmpTranslator,
  projectOmpCommands,
  translateOmpResponseData,
} from "./protocol.ts";

const approvalRequest = {
  type: "extension_ui_request",
  id: "15cfcc57317e7bcc",
  method: "select",
  title: "Allow tool: bash\nCommand: echo omp-probe",
  options: ["Approve", "Approve bash for this session", "Deny"],
};

const agentEnd = (extra: Record<string, unknown> = {}, stopReason = "stop") => ({
  type: "agent_end",
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "pong" }], stopReason },
  ],
  ...extra,
});

const outbound = (translator: OmpTranslator, ...frames: ReadonlyArray<Record<string, unknown>>) =>
  frames.flatMap((frame) => translator.fromOmp(frame));

describe("omp outbound frames", () => {
  it("drops frames Pi has no equivalent for", () => {
    const translator = makeOmpTranslator();
    expect(
      outbound(
        translator,
        {
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1048576,
        },
        { type: "prompt_result", id: "p1", agentInvoked: true, status: "completed" },
        { type: "session_settled" },
      ),
    ).toEqual([]);
  });

  it("settles when the agent yields, not when the whole session is done", () => {
    const translator = makeOmpTranslator();
    expect(outbound(translator, { type: "agent_start" }, agentEnd({ yielded: true }))).toEqual([
      { type: "agent_start" },
      expect.objectContaining({ type: "agent_end" }),
      { type: "agent_settled", aborted: false },
    ]);
  });

  it("does not settle while omp retries or compacts on its own", () => {
    const translator = makeOmpTranslator();
    expect(
      outbound(
        translator,
        { type: "agent_start" },
        agentEnd({ yielded: false, isTerminal: false }),
      ),
    ).toEqual([{ type: "agent_start" }, expect.objectContaining({ type: "agent_end" })]);
  });

  it("settles an old runtime's terminal end that carries no yielded field", () => {
    const translator = makeOmpTranslator();
    expect(outbound(translator, agentEnd({ isTerminal: true })).map((f) => f["type"])).toEqual([
      "agent_end",
      "agent_settled",
    ]);
    expect(outbound(translator, agentEnd()).map((f) => f["type"])).toEqual(["agent_end"]);
  });

  it("reports an aborted settle from the last assistant message", () => {
    const translator = makeOmpTranslator();
    expect(outbound(translator, agentEnd({ yielded: true }, "aborted")).at(-1)).toEqual({
      type: "agent_settled",
      aborted: true,
    });
  });

  it("renames compaction events and normalizes their results", () => {
    const translator = makeOmpTranslator();
    expect(
      outbound(
        translator,
        { type: "manual_compaction_start" },
        {
          type: "manual_compaction_end",
          aborted: false,
          result: { summary: "kept", firstKeptEntryId: "e1", tokensBefore: 48210 },
        },
        { type: "auto_compaction_start", reason: "threshold", action: "context-full" },
        {
          type: "auto_compaction_end",
          reason: "threshold",
          action: "context-full",
          aborted: false,
          willRetry: true,
          result: { summary: "again", tokensBefore: 90000 },
        },
        {
          type: "manual_compaction_end",
          aborted: false,
          skipped: true,
          errorMessage: "Already compacted",
        },
        { type: "manual_compaction_end", aborted: true },
      ),
    ).toEqual([
      { type: "compaction_start", reason: "manual" },
      {
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
        result: { summary: "kept", tokensBefore: 48210 },
      },
      { type: "compaction_start", reason: "threshold" },
      {
        type: "compaction_end",
        reason: "threshold",
        aborted: false,
        willRetry: true,
        result: { summary: "again", tokensBefore: 90000 },
      },
      {
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
        result: null,
        errorMessage: "Already compacted",
      },
      { type: "compaction_end", reason: "manual", aborted: true, willRetry: false, result: null },
    ]);
  });

  it("presents an omp approval prompt as the confirm dialog the adapter expects", () => {
    const translator = makeOmpTranslator();
    expect(outbound(translator, approvalRequest)).toEqual([
      {
        type: "extension_ui_request",
        id: "15cfcc57317e7bcc",
        method: "confirm",
        title: "Allow bash?",
        message: "Command: echo omp-probe",
      },
    ]);
  });

  it("leaves other dialogs, such as the ask tool's questions, as they are", () => {
    const translator = makeOmpTranslator();
    const ask = {
      type: "extension_ui_request",
      id: "ui_2",
      method: "select",
      title: "Which database?",
      options: ["Postgres", "SQLite"],
    };
    expect(outbound(translator, ask)).toEqual([ask]);
  });

  it("passes ordinary session events through", () => {
    const translator = makeOmpTranslator();
    const events = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "p" } },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000 },
    ];
    expect(outbound(translator, ...events)).toEqual(events);
  });
});

describe("omp prompt acknowledgements", () => {
  it("marks a prompt that finished locally as handled", () => {
    const translator = makeOmpTranslator();
    translator.toOmp({ type: "prompt", id: "p1", message: "/fast" });
    expect(
      outbound(translator, {
        id: "p1",
        type: "response",
        command: "prompt",
        success: true,
        data: { agentInvoked: false },
      }),
    ).toEqual([
      {
        id: "p1",
        type: "response",
        command: "prompt",
        success: true,
        data: { agentInvoked: false, disposition: "handled" },
      },
    ]);
  });

  it("marks a prompt sent while the agent is running as queued", () => {
    const translator = makeOmpTranslator();
    outbound(translator, { type: "agent_start" });
    translator.toOmp({
      type: "prompt",
      id: "p2",
      message: "also this",
      streamingBehavior: "steer",
    });
    expect(
      outbound(translator, { id: "p2", type: "response", command: "prompt", success: true }),
    ).toEqual([
      {
        id: "p2",
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "queued" },
      },
    ]);
  });

  it("leaves the acknowledgement of a prompt that starts a turn alone", () => {
    const translator = makeOmpTranslator();
    translator.toOmp({ type: "prompt", id: "p3", message: "hello" });
    const ack = { id: "p3", type: "response", command: "prompt", success: true };
    expect(outbound(translator, ack)).toEqual([ack]);
  });

  it("forgets a prompt once the agent yielded before the next one", () => {
    const translator = makeOmpTranslator();
    outbound(translator, { type: "agent_start" }, agentEnd({ yielded: true }));
    translator.toOmp({ type: "prompt", id: "p4", message: "next", streamingBehavior: "steer" });
    const ack = { id: "p4", type: "response", command: "prompt", success: true };
    expect(outbound(translator, ack)).toEqual([ack]);
  });
});

describe("omp inbound commands", () => {
  it("answers an approval prompt with omp's own choice labels", () => {
    const translator = makeOmpTranslator();
    outbound(translator, approvalRequest);
    expect(
      translator.toOmp({ type: "extension_ui_response", id: "15cfcc57317e7bcc", confirmed: true }),
    ).toEqual({ type: "extension_ui_response", id: "15cfcc57317e7bcc", value: "Approve" });
    outbound(translator, { ...approvalRequest, id: "second" });
    expect(
      translator.toOmp({ type: "extension_ui_response", id: "second", confirmed: false }),
    ).toEqual({ type: "extension_ui_response", id: "second", value: "Deny" });
    outbound(translator, { ...approvalRequest, id: "third" });
    expect(
      translator.toOmp({ type: "extension_ui_response", id: "third", cancelled: true }),
    ).toEqual({ type: "extension_ui_response", id: "third", cancelled: true });
  });

  it("passes responses to other dialogs through", () => {
    const translator = makeOmpTranslator();
    const response = { type: "extension_ui_response", id: "ui_2", value: "SQLite" };
    expect(translator.toOmp(response)).toEqual(response);
  });

  it("renames the commands omp serves under another name", () => {
    const translator = makeOmpTranslator();
    expect(translator.toOmp({ type: "get_commands", id: "a" })).toEqual({
      type: "get_available_commands",
      id: "a",
    });
    expect(translator.toOmp({ type: "clear_queue", id: "b" })).toEqual({
      type: "abort_and_restore_queue",
      id: "b",
    });
  });

  it("passes everything else through", () => {
    const translator = makeOmpTranslator();
    const commands = [
      { type: "get_state", id: "1" },
      { type: "set_model", id: "2", provider: "magpie", modelId: "auto/deepseek-v4.1-flash" },
      { type: "switch_session", id: "3", sessionPath: "/s/a.jsonl" },
      { type: "compact", id: "4", customInstructions: "focus" },
      { type: "abort", id: "5" },
    ];
    for (const command of commands) expect(translator.toOmp(command)).toEqual(command);
  });
});

describe("omp response data", () => {
  it("counts only the queued messages a user could still withdraw as pending", () => {
    expect(
      translateOmpResponseData("get_state", {
        isStreaming: false,
        queuedMessageCount: 3,
        queuedMessages: { steering: ["one"], followUp: ["two"] },
      }),
    ).toEqual({
      isStreaming: false,
      queuedMessageCount: 3,
      queuedMessages: { steering: ["one"], followUp: ["two"] },
      pendingMessageCount: 2,
    });
    expect(translateOmpResponseData("get_state", { isStreaming: true })).toEqual({
      isStreaming: true,
      pendingMessageCount: 0,
    });
  });

  it("hands back withdrawn queue text as Pi's clear_queue does", () => {
    expect(
      translateOmpResponseData("clear_queue", {
        steering: [{ text: "Use the existing parser" }],
        followUp: [{ text: "Then run the tests", images: [{ type: "image" }] }],
      }),
    ).toEqual({ steering: ["Use the existing parser"], followUp: ["Then run the tests"] });
  });

  it("leaves other data alone", () => {
    const data = { messages: [] };
    expect(translateOmpResponseData("get_messages", data)).toBe(data);
  });
});

describe("omp command discovery", () => {
  it("keeps skills and workspace commands and only the builtins that work over RPC", () => {
    const projected = projectOmpCommands({
      commands: [
        { name: "security", source: "builtin", description: "Scans" },
        { name: "compact", source: "builtin", description: "Compact the conversation" },
        { name: "new", source: "builtin", description: "Start a new session" },
        { name: "skill:agent-browser", source: "skill", description: "Browser automation" },
        {
          name: "green",
          source: "custom",
          description: "Iterate on CI",
          input: { hint: "arguments" },
        },
        { name: "init", source: "file" },
        { name: "autoresearch", source: "extension", description: "Toggle autoresearch" },
      ],
    });
    expect(projected).toEqual({
      commands: [
        { name: "skill:agent-browser", source: "skill", description: "Browser automation" },
        { name: "green", source: "prompt", description: "Iterate on CI" },
        { name: "init", source: "prompt" },
        { name: "autoresearch", source: "extension", description: "Toggle autoresearch" },
      ],
    });
  });

  it("tolerates a malformed catalog", () => {
    expect(projectOmpCommands(undefined)).toEqual({ commands: [] });
    expect(projectOmpCommands({ commands: "nope" })).toEqual({ commands: [] });
  });
});
