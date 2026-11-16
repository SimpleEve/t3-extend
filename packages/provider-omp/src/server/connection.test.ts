// @effect-diagnostics globalFetch:off - The MCP client under test uses the global fetch, so the test stubs it.
import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeOmpRpcConnection } from "./connection.ts";
import { makeFakeOmp } from "./fakeOmp.testkit.ts";

const mcpSession = {
  endpoint: "http://t3.test/mcp",
  authorizationHeader: "Bearer session-token",
} as never;

const TOOLS = [
  {
    name: "delegate_task",
    description: "Start a delegated task",
    inputSchema: { type: "object", properties: { task: { type: "string" } } },
  },
  { name: "t3_thread_list" },
];

/** A T3 MCP server that answers initialize, tools/list and tools/call. */
const stubMcpServer = () => {
  const calls: Array<{ readonly method: string; readonly params: unknown; readonly auth: string }> =
    [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      id?: number;
      params?: unknown;
    };
    const headers = new Headers(init?.headers);
    calls.push({
      method: body.method,
      params: body.params,
      auth: headers.get("authorization") ?? "",
    });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === "tools/list"
        ? { tools: TOOLS }
        : body.method === "tools/call"
          ? {
              content: [{ type: "text", text: "task started" }],
              structuredContent: { taskId: "t1" },
            }
          : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
  return { calls, restore: () => spy.mockRestore() };
};

describe("omp connection", () => {
  it.effect("registers T3's MCP tools with omp and runs the calls omp hands back", () =>
    Effect.gen(function* () {
      const mcp = stubMcpServer();
      yield* Effect.addFinalizer(() => Effect.sync(mcp.restore));
      const fake = yield* makeFakeOmp();
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        mcpSession,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));

      const registration = yield* fake.takeRequest("set_host_tools");
      assert.deepEqual(
        (registration["tools"] as Array<{ name: string; loadMode: string }>).map((tool) => [
          tool.name,
          tool.loadMode,
        ]),
        [
          ["mcp__t3-code__delegate_task", "essential"],
          ["mcp__t3-code__t3_thread_list", "discoverable"],
        ],
      );
      assert.isTrue(mcp.calls.every((call) => call.auth === "Bearer session-token"));

      yield* fake.emit({
        type: "host_tool_call",
        id: "host_1",
        toolCallId: "toolu_1",
        toolName: "mcp__t3-code__delegate_task",
        arguments: { task: "write the docs" },
      });
      const result = yield* fake.takeRequest("host_tool_result");
      assert.deepEqual(result, {
        type: "host_tool_result",
        id: "host_1",
        result: { content: [{ type: "text", text: "task started" }] },
      });
      assert.deepEqual(mcp.calls.at(-1)?.params, {
        name: "delegate_task",
        arguments: { task: "write the docs" },
      });

      // Host tool frames never reach the adapter; ordinary frames still do.
      yield* fake.emit({ type: "agent_start" });
      const forwarded = yield* Queue.take(connection.events);
      assert.equal(forwarded["type"], "agent_start");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a host tool call that is not one of T3's, and reports MCP failures", () =>
    Effect.gen(function* () {
      const mcp = stubMcpServer();
      yield* Effect.addFinalizer(() => Effect.sync(mcp.restore));
      const fake = yield* makeFakeOmp();
      yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        mcpSession,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      yield* fake.takeRequest("set_host_tools");

      yield* fake.emit({ type: "host_tool_call", id: "h1", toolName: "other", arguments: {} });
      const unknown = yield* fake.takeRequest("host_tool_result");
      assert.equal(unknown["isError"], true);

      mcp.restore();
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
      yield* fake.emit({
        type: "host_tool_call",
        id: "h2",
        toolName: "mcp__t3-code__t3_thread_list",
        arguments: {},
      });
      const failed = yield* fake.takeRequest("host_tool_result");
      assert.equal(failed["isError"], true);
      assert.include(JSON.stringify(failed["result"]), "connection refused");
    }).pipe(Effect.scoped),
  );

  it.effect("starts without T3's tools when the MCP server is unreachable", () =>
    Effect.gen(function* () {
      const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const fake = yield* makeFakeOmp();
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        mcpSession,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      // The prompt is held until registration settles, then goes through without tools.
      yield* connection.send({ type: "prompt", id: "p1", message: "hello" });
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "hello");
      assert.isUndefined(
        fake.allRequests().find((request) => request["type"] === "set_host_tools"),
      );
    }).pipe(Effect.scoped),
  );
});
