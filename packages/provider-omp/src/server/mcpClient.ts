// @effect-diagnostics globalFetch:off - Requests carry the abort signal of the Effect fiber that awaits them.
// A minimal MCP client for T3's own per-session HTTP server (initialize, tools/list, tools/call).
import * as Schema from "effect/Schema";

const PROTOCOL = "2025-06-18";

export interface OmpMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

export interface OmpMcpCallResult {
  readonly content?: ReadonlyArray<{
    readonly type?: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

interface JsonRpcResponse {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

function parseBody(body: string, contentType: string): JsonRpcResponse {
  if (!contentType.includes("text/event-stream")) return JSON.parse(body) as JsonRpcResponse;
  for (const line of body.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (data.length === 0) continue;
    const parsed = JSON.parse(data) as JsonRpcResponse;
    if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
      return parsed;
    }
  }
  throw new Error("MCP SSE response had no JSON-RPC payload.");
}

export function makeOmpMcpClient(endpoint: string, authorizationHeader: string) {
  let nextId = 1;
  let sessionId: string | undefined;

  const headers = (): Record<string, string> => ({
    accept: "application/json, text/event-stream",
    authorization: authorizationHeader,
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL,
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  });

  const request = async (method: string, params: unknown, signal?: AbortSignal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      ...(signal === undefined ? {} : { signal }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`MCP ${method} failed (${response.status}): ${body.slice(0, 400)}`);
    }
    if (body.length === 0) return undefined;
    const parsed = parseBody(body, response.headers.get("content-type") ?? "");
    if (parsed.error !== undefined) {
      throw new Error(parsed.error.message ?? `MCP ${method} returned an error`);
    }
    return parsed.result;
  };

  return {
    async connect(signal?: AbortSignal): Promise<void> {
      await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "t3-omp-mcp", version: "1.0.0" },
        },
        signal,
      );
      await fetch(endpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        ...(signal === undefined ? {} : { signal }),
      }).catch(() => undefined);
    },
    async listTools(signal?: AbortSignal): Promise<ReadonlyArray<OmpMcpTool>> {
      const tools: Array<OmpMcpTool> = [];
      let cursor: string | undefined;
      do {
        const result = (await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        )) as { tools?: Array<OmpMcpTool>; nextCursor?: string } | undefined;
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<OmpMcpCallResult> {
      return ((await request("tools/call", { name, arguments: args }, signal)) ??
        {}) as OmpMcpCallResult;
    },
  };
}

export type OmpMcpClient = ReturnType<typeof makeOmpMcpClient>;

export class OmpMcpError extends Schema.TaggedError<OmpMcpError>()("OmpMcpError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `omp MCP ${this.operation} failed.`;
  }
}
