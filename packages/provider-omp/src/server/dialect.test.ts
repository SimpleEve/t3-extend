import { describe, expect, it } from "@effect/vitest";

import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./dialect.ts";

const launch = (input: Partial<Parameters<typeof buildOmpRpcLaunch>[0]> = {}) =>
  buildOmpRpcLaunch({
    launchArgs: [],
    environment: { HOME: "/home/user" },
    mcpSession: undefined,
    extensionPath: undefined,
    ...input,
  });

describe("omp launch arguments", () => {
  it("accepts ordinary flags, with or without = for flags that take a value", () => {
    expect(resolveOmpLaunchArgs("--model=opus --thinking high --no-lsp")).toEqual({
      ok: true,
      args: ["--model", "opus", "--thinking", "high", "--no-lsp"],
    });
    expect(resolveOmpLaunchArgs("")).toEqual({ ok: true, args: [] });
  });

  it.each([
    ["--mode text", "--mode"],
    ["--resume abc", "--resume"],
    ["-c", "-c"],
    ["--yolo", "--yolo"],
    ["--auto-approve", "--auto-approve"],
    ["--approval-mode=yolo", "--approval-mode"],
    ["--no-session", "--no-session"],
  ])("keeps T3's own flag %s out of the settings", (launchArgs, flag) => {
    expect(resolveOmpLaunchArgs(launchArgs)).toEqual({
      ok: false,
      message: `omp launch argument '${flag}' is controlled by T3 Code and cannot be overridden.`,
    });
  });

  it("rejects a stray prompt, which omp would otherwise send as the first message", () => {
    expect(resolveOmpLaunchArgs("--no-lsp list the files")).toEqual({
      ok: false,
      message: "omp launch arguments cannot include positional prompt 'list'.",
    });
    expect(resolveOmpLaunchArgs("--model")).toEqual({
      ok: false,
      message: "omp launch argument '--model' requires a value.",
    });
  });
});

describe("omp launch command line", () => {
  it("binds the session by file and maps each runtime mode to omp's own approval mode", () => {
    expect(launch({ sessionPath: "/s/a.jsonl", runtimeMode: "approval-required" }).args).toEqual([
      "--mode",
      "rpc-ui",
      "--resume",
      "/s/a.jsonl",
      "--approval-mode",
      "always-ask",
    ]);
    const modeOf = (runtimeMode: "auto" | "auto-accept-edits" | "full-access") =>
      launch({ runtimeMode }).args.at(-1);
    expect(modeOf("auto")).toBe("always-ask");
    expect(modeOf("auto-accept-edits")).toBe("write");
    expect(modeOf("full-access")).toBe("yolo");
  });

  it("puts T3's approval mode after the user's arguments", () => {
    const args = launch({ launchArgs: ["--thinking", "high"], runtimeMode: "full-access" }).args;
    expect(args.indexOf("--thinking")).toBeLessThan(args.indexOf("--approval-mode"));
  });

  it("starts probes without a session, extensions, tools or an approval mode", () => {
    expect(launch({ ephemeral: true, disableExtensions: true, disableTools: true }).args).toEqual([
      "--mode",
      "rpc-ui",
      "--no-session",
      "--no-extensions",
      "--no-tools",
    ]);
  });

  it("appends T3's orchestration guidance only when the thread has MCP tools", () => {
    const withoutMcp = launch().args;
    expect(withoutMcp).not.toContain("--append-system-prompt");
    const mcpSession = { endpoint: "http://127.0.0.1:1/mcp", authorizationHeader: "Bearer x" };
    const args = launch({ mcpSession: mcpSession as never }).args;
    expect(args.at(-2)).toBe("--append-system-prompt");
    expect(args.at(-1)).toContain("T3 Code orchestration");
  });

  it("passes the instance environment through untouched", () => {
    expect(launch().env).toEqual({ HOME: "/home/user" });
  });
});
