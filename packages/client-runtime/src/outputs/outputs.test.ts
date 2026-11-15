import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isNoiseOutputPath, normalizeOutputPath } from "./paths.ts";
import { deriveRunOutputs, EMPTY_RUN_OUTPUTS, replyLinkedFiles } from "./runOutputs.ts";
import {
  createThreadOutputsDeriver,
  mergeThreadOutputs,
  type ThreadOutputsSource,
} from "./threadOutputs.ts";
import {
  COMMAND_OUTPUT_URL_LIMIT,
  commandOutputUrls,
  extractHttpUrls,
  isDiagnosticCommand,
} from "./urls.ts";

const CWD = "/work/app";
const run = (id: string) => id as RunId;

const fileChange = (...paths: string[]) =>
  ({
    type: "file_change",
    fileName: paths[0]!,
    changes: paths.map((path) => ({ operation: "update", path })),
  }) as const;

// Fields a test sets by hand; the real items come from the projection.
const rawItem = <T extends { type: string }>(item: T): { readonly type: string } => item;

const command = (input: string, output?: string) =>
  ({ type: "command_execution", input, ...(output === undefined ? {} : { output }) }) as const;

describe("extractHttpUrls", () => {
  it.each([
    ["localhost", "ready on http://localhost:3000/", ["http://localhost:3000"]],
    ["loopback", "http://127.0.0.1:5173/app", ["http://127.0.0.1:5173/app"]],
    ["any address", "listening at http://0.0.0.0:8080", ["http://0.0.0.0:8080"]],
    ["lan address", "Network: http://192.168.1.20:5173/", ["http://192.168.1.20:5173"]],
    [
      "tunnel domain",
      "https://abc-123.trycloudflare.com/x?y=1",
      ["https://abc-123.trycloudflare.com/x?y=1"],
    ],
    ["trailing punctuation", "see https://example.com/docs.", ["https://example.com/docs"]],
    ["markdown link", "[docs](https://example.com/a) done", ["https://example.com/a"]],
    [
      "balanced parentheses",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      ["https://en.wikipedia.org/wiki/Foo_(bar)"],
    ],
    ["ansi escape", "\u001b[36mhttp://localhost:4000/\u001b[0m", ["http://localhost:4000"]],
    ["xml namespace", 'xmlns="http://www.w3.org/2000/svg"', []],
    ["other schemes", "ftp://host/file ws://host/socket", []],
    [
      "repeats collapse",
      "http://localhost:3000 http://localhost:3000/ http://localhost:3000",
      ["http://localhost:3000"],
    ],
  ])("%s", (_name, text, expected) => {
    expect(extractHttpUrls(text)).toEqual(expected);
  });
});

describe("commandOutputUrls", () => {
  const url = (index: number) => `http://localhost:${3000 + index}/`;

  it.each([
    ["ssh", "ssh -L 3000:localhost:3000 host"],
    ["ss", "ss -ltnp"],
    ["netstat", "sudo netstat -an | grep 3000"],
    ["lsof", "lsof -i :3000"],
    ["nmap", "nmap -p 3000 localhost"],
    ["a pipeline", "cat hosts && ssh host"],
  ])("skips the output of %s", (_name, cmd) => {
    expect(isDiagnosticCommand(cmd)).toBe(true);
    expect(commandOutputUrls(cmd, url(0))).toEqual([]);
  });

  it.each([
    ["a similar name", "ssh-keygen -t ed25519"],
    ["a longer word", "pass show"],
    ["a plain build", "pnpm dev"],
  ])("keeps the output of %s", (_name, cmd) => {
    expect(isDiagnosticCommand(cmd)).toBe(false);
    expect(commandOutputUrls(cmd, url(0))).toEqual(["http://localhost:3000"]);
  });

  it("keeps an output below the limit and skips it at the limit", () => {
    const below = Array.from({ length: COMMAND_OUTPUT_URL_LIMIT - 1 }, (_, index) => url(index));
    const atLimit = Array.from({ length: COMMAND_OUTPUT_URL_LIMIT }, (_, index) => url(index));
    expect(commandOutputUrls("pnpm dev", below.join("\n"))).toHaveLength(
      COMMAND_OUTPUT_URL_LIMIT - 1,
    );
    expect(commandOutputUrls("pnpm dev", atLimit.join("\n"))).toEqual([]);
  });

  it("counts distinct URLs, so a server repeating its address is not a listing", () => {
    expect(commandOutputUrls("pnpm dev", `${url(0)}\n${url(0)}\n${url(0)}\n${url(0)}\n`)).toEqual([
      "http://localhost:3000",
    ]);
  });

  it("has nothing to read without output", () => {
    expect(commandOutputUrls("pnpm dev", undefined)).toEqual([]);
    expect(commandOutputUrls("pnpm dev", "")).toEqual([]);
  });
});

describe("normalizeOutputPath", () => {
  it.each([
    ["absolute", "/work/app/a.ts", "/work/app/a.ts", undefined],
    ["relative", "src/a.ts", "/work/app/src/a.ts", undefined],
    ["dot prefix", "./src/a.ts", "/work/app/src/a.ts", undefined],
    ["parent segments", "src/../lib/./a.ts", "/work/app/lib/a.ts", undefined],
    ["repeated separators", "/work//app///a.ts", "/work/app/a.ts", undefined],
    ["line suffix", "/work/app/a.ts:42", "/work/app/a.ts", 42],
    ["line and column", "src/a.ts:42:7", "/work/app/src/a.ts", 42],
    ["windows drive", "C:\\Users\\me\\a.txt", "C:\\Users\\me\\a.txt", undefined],
    ["windows mixed", "C:/Users/me/./a.txt", "C:\\Users\\me\\a.txt", undefined],
  ])("%s", (_name, raw, path, line) => {
    expect(normalizeOutputPath(raw, CWD)).toEqual({
      path,
      ...(line === undefined ? {} : { line }),
    });
  });

  it.each([
    ["a folder", "/work/app/src/"],
    ["a share", "//host/share/a.txt"],
    ["only the root", "/"],
    ["empty", "  "],
  ])("rejects %s", (_name, raw) => {
    expect(normalizeOutputPath(raw, CWD)).toBeNull();
  });

  it("cannot resolve a relative path without a working directory", () => {
    expect(normalizeOutputPath("src/a.ts", undefined)).toBeNull();
    expect(normalizeOutputPath("/tmp/a.ts", undefined)).toEqual({ path: "/tmp/a.ts" });
  });

  it.each([
    ["/work/app/node_modules/x/index.js", true],
    ["/work/app/.git/config", true],
    ["/work/app/src/node_modules_notes.md", false],
  ])("flags %s as noise: %s", (path, noise) => {
    expect(isNoiseOutputPath(path)).toBe(noise);
  });
});

describe("replyLinkedFiles", () => {
  it.each([
    ["absolute", "[a](/tmp/report.md)", [{ path: "/tmp/report.md" }]],
    ["relative", "[a](docs/report.md)", [{ path: "/work/app/docs/report.md" }]],
    ["dot relative", "[a](./out/report.md)", [{ path: "/work/app/out/report.md" }]],
    ["file url", "[a](file:///tmp/report.md)", [{ path: "/tmp/report.md" }]],
    ["encoded file url", "[a](file:///tmp/my%20report.md)", [{ path: "/tmp/my report.md" }]],
    ["line suffix", "[a](/tmp/report.md:12)", [{ path: "/tmp/report.md", line: 12 }]],
    ["line hash", "[a](/tmp/report.md#L7)", [{ path: "/tmp/report.md", line: 7 }]],
    ["home", "[a](~/notes/a.md)", []],
    ["web link", "[a](https://example.com/a.md)", []],
    ["a route", "[a](/api/users)", []],
    ["an anchor", "[a](#section)", []],
    ["plain text path", "wrote /tmp/report.md", []],
    ["a folder", "[a](docs/)", []],
  ])("%s", (_name, markdown, expected) => {
    expect(replyLinkedFiles(markdown, CWD)).toEqual(expected.map((file) => ({ ...file })));
  });

  it("keeps the order the reply links them in", () => {
    expect(
      replyLinkedFiles("[b](/tmp/b.md) then [a](/tmp/a.md)", CWD).map((file) => file.path),
    ).toEqual(["/tmp/b.md", "/tmp/a.md"]);
  });

  it("leaves relative links out when there is no working directory", () => {
    expect(replyLinkedFiles("[a](docs/a.md) [b](/tmp/b.md)", undefined)).toEqual([
      { path: "/tmp/b.md" },
    ]);
  });
});

describe("deriveRunOutputs", () => {
  it("lists reply-linked files before changed files and links last", () => {
    const outputs = deriveRunOutputs({
      replyText: "Done: [report](/tmp/report.md), served at http://localhost:3000/",
      items: [fileChange("src/a.ts", "src/b.ts"), command("pnpm dev", "http://localhost:5173/")],
      cwd: CWD,
    });
    expect(outputs.files).toEqual([
      { path: "/tmp/report.md", source: "reply" },
      { path: "/work/app/src/a.ts", source: "changed" },
      { path: "/work/app/src/b.ts", source: "changed" },
    ]);
    expect(outputs.links).toEqual([
      { url: "http://localhost:3000" },
      { url: "http://localhost:5173" },
    ]);
  });

  it("keeps one file linked by the reply and written by a tool, as the reply's", () => {
    const outputs = deriveRunOutputs({
      replyText: "[a](src/a.ts:9)",
      items: [fileChange("/work/app/src/a.ts"), fileChange("src/./a.ts")],
      checkpointFiles: [{ path: "src/a.ts", kind: "modified" }],
      cwd: CWD,
    });
    expect(outputs.files).toEqual([{ path: "/work/app/src/a.ts", line: 9, source: "reply" }]);
  });

  it("merges checkpoint files, skips deleted ones, and keeps noise out", () => {
    const outputs = deriveRunOutputs({
      replyText: undefined,
      items: [
        fileChange("node_modules/x/index.js"),
        rawItem({
          type: "file_change",
          fileName: "old.ts",
          changes: [{ operation: "delete", path: "old.ts" }],
        }),
      ],
      checkpointFiles: [
        { path: "new.ts", kind: "added" },
        { path: "gone.ts", kind: "deleted" },
        { path: ".git/HEAD", kind: "modified" },
      ],
      cwd: CWD,
    });
    expect(outputs.files).toEqual([{ path: "/work/app/new.ts", source: "changed" }]);
  });

  it("falls back to the file name when a change has no details", () => {
    expect(
      deriveRunOutputs({
        replyText: "",
        items: [rawItem({ type: "file_change", fileName: "/tmp/x.txt" })],
        cwd: CWD,
      }).files,
    ).toEqual([{ path: "/tmp/x.txt", source: "changed" }]);
  });

  it("applies the command exclusions but reads every URL in the reply", () => {
    const flood = Array.from({ length: 5 }, (_, index) => `http://localhost:${4000 + index}`);
    const outputs = deriveRunOutputs({
      replyText: flood.join(" "),
      items: [
        command("ssh host", "http://localhost:9000"),
        command("ls", flood.join("\n")),
        command("echo", "http://localhost:9001"),
      ],
      cwd: CWD,
    });
    expect(outputs.links.map((link) => link.url)).toEqual([...flood, "http://localhost:9001"]);
  });

  it("ignores withheld output", () => {
    expect(
      deriveRunOutputs({
        replyText: undefined,
        items: [rawItem({ type: "command_execution", input: "pnpm dev", outputOmitted: true })],
        cwd: CWD,
      }),
    ).toBe(EMPTY_RUN_OUTPUTS);
  });

  it.each([
    ["a dot folder", "[config](.git/config)", "/work/app/.git/config"],
    ["a dependency", "[x](/work/app/node_modules/x/a.js)", "/work/app/node_modules/x/a.js"],
    ["a nested dependency", "[x](pkg/node_modules/x/a.js:3)", "/work/app/pkg/node_modules/x/a.js"],
  ])("keeps %s out even when the reply links it", (_name, markdown, path) => {
    const outputs = deriveRunOutputs({
      replyText: `${markdown} and [ok](src/ok.ts)`,
      items: [],
      cwd: CWD,
    });
    expect(outputs.files.map((file) => file.path)).toEqual(["/work/app/src/ok.ts"]);
    expect(outputs.files.map((file) => file.path)).not.toContain(path);
  });

  it("derives every file a run wrote; the lists cut them for display", () => {
    const outputs = deriveRunOutputs({
      replyText: undefined,
      items: [fileChange(...Array.from({ length: 150 }, (_, index) => `gen/${index}.ts`))],
      cwd: CWD,
    });
    expect(outputs.files).toHaveLength(150);
    expect(outputs.files[0]!.path).toBe("/work/app/gen/0.ts");
  });
});

describe("mergeThreadOutputs", () => {
  const outputs = (files: string[], links: string[] = []) => ({
    files: files.map((path) => ({ path, source: "changed" as const })),
    links: links.map((url) => ({ url })),
  });

  it("puts the newest run first and keeps each output once, where it first appears", () => {
    const merged = mergeThreadOutputs([
      { runId: run("r1"), outputs: outputs(["/a", "/b"], ["http://x"]) },
      { runId: run("r2"), outputs: outputs(["/c", "/a"], ["http://y", "http://x"]) },
    ]);
    expect(merged.files.map((file) => [file.path, file.runId])).toEqual([
      ["/c", "r2"],
      ["/a", "r2"],
      ["/b", "r1"],
    ]);
    expect(merged.links.map((link) => [link.url, link.runId])).toEqual([
      ["http://y", "r2"],
      ["http://x", "r2"],
    ]);
  });

  it("folds paths that differ only in case on Windows", () => {
    const merged = mergeThreadOutputs([
      { runId: run("r1"), outputs: outputs(["C:\\Work\\A.txt"]) },
      { runId: run("r2"), outputs: outputs(["c:\\work\\a.txt"]) },
    ]);
    expect(merged.files).toHaveLength(1);
    expect(merged.files[0]!.runId).toBe("r2");
  });

  it("keeps the real totals when the lists are cut", () => {
    const merged = mergeThreadOutputs([
      {
        runId: run("r1"),
        outputs: outputs(
          Array.from({ length: 350 }, (_, index) => `/f/${index}`),
          Array.from({ length: 120 }, (_, index) => `http://h/${index}`),
        ),
      },
      { runId: run("r2"), outputs: outputs(["/f/0", "/f/new"], ["http://h/0"]) },
    ]);
    expect(merged.files).toHaveLength(300);
    expect(merged.links).toHaveLength(100);
    expect(merged.filesTotal).toBe(351);
    expect(merged.linksTotal).toBe(120);
    expect(merged.files[0]!.path).toBe("/f/0");
  });

  it("indexes only runs that produced something", () => {
    const merged = mergeThreadOutputs([
      { runId: run("r1"), outputs: EMPTY_RUN_OUTPUTS },
      { runId: run("r2"), outputs: outputs(["/a"]) },
    ]);
    expect([...merged.byRunId.keys()]).toEqual(["r2"]);
  });
});

describe("createThreadOutputsDeriver", () => {
  const runRow = (id: string, ordinal: number, status: string) =>
    ({ id, ordinal, status }) as unknown as OrchestrationV2ThreadProjection["runs"][number];
  const item = (runId: string, ordinal: number, body: Record<string, unknown>) =>
    ({
      runId,
      ordinal,
      ...body,
    }) as unknown as OrchestrationV2ThreadProjection["turnItems"][number];
  const reply = (runId: string, text: string) =>
    item(runId, 99, { type: "assistant_message", text, streaming: false });

  const source = (
    runs: OrchestrationV2ThreadProjection["runs"],
    turnItems: OrchestrationV2ThreadProjection["turnItems"],
  ): ThreadOutputsSource => ({
    runs,
    turnItems,
    checkpointFilesByRunId: new Map(),
    cwd: CWD,
  });

  it("derives only finished runs, newest first, from the last assistant message", () => {
    const derive = createThreadOutputsDeriver();
    const result = derive(
      source(
        [runRow("r2", 2, "running"), runRow("r1", 1, "completed"), runRow("r3", 3, "rolled_back")],
        [
          item("r1", 1, { ...fileChange("a.ts") }),
          reply("r1", "[old](/tmp/old.md)"),
          item("r1", 100, { type: "assistant_message", text: "[final](/tmp/final.md)" }),
          item("r2", 1, { ...fileChange("b.ts") }),
          item("r3", 1, { ...fileChange("c.ts") }),
        ],
      ),
    );
    expect(result.files.map((file) => file.path)).toEqual(["/tmp/final.md", "/work/app/a.ts"]);
  });

  it("keeps the result's identity while nothing it reads changes", () => {
    const derive = createThreadOutputsDeriver();
    const finished = [item("r1", 1, { ...fileChange("a.ts") }), reply("r1", "done")];
    const runs = [runRow("r1", 1, "completed")];
    const first = derive(source(runs, finished));
    const streaming = [...finished, item("r2", 1, { ...fileChange("b.ts") })];
    const second = derive(source([...runs, runRow("r2", 2, "running")], streaming));
    expect(second).toBe(first);
    expect(second.byRunId.get(run("r1"))).toBe(first.byRunId.get(run("r1")));
  });

  it("adds a run's outputs once it finishes and keeps the earlier run's object", () => {
    const derive = createThreadOutputsDeriver();
    const r1Items = [item("r1", 1, { ...fileChange("a.ts") })];
    const r2Items = [item("r2", 1, { ...fileChange("b.ts") })];
    const first = derive(source([runRow("r1", 1, "completed")], r1Items));
    const second = derive(
      source(
        [runRow("r1", 1, "completed"), runRow("r2", 2, "completed")],
        [...r1Items, ...r2Items],
      ),
    );
    expect(second.files.map((file) => file.path)).toEqual(["/work/app/b.ts", "/work/app/a.ts"]);
    expect(second.byRunId.get(run("r1"))).toBe(first.byRunId.get(run("r1")));
  });
});
