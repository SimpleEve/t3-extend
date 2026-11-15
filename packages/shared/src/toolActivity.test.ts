import { describe, expect, it } from "vite-plus/test";

import {
  classifyToolActivity,
  dynamicToolSurface,
  formatReadToolLabel,
  formatSearchToolLabel,
  mergeToolActivityData,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("classifies from kind and toolName without sniffing titles", () => {
    expect(classifyToolActivity({ data: { kind: "read" } })).toBe("read");
    expect(classifyToolActivity({ data: { toolName: "Grep" } })).toBe("search");
    expect(classifyToolActivity({ data: { toolName: "Read" } })).toBe("read");
    for (const toolName of ["github.read_file", "mongodb.find", "mcp__github__read_file"]) {
      expect(classifyToolActivity({ data: { toolName } })).toBe("other");
    }
    expect(classifyToolActivity({ title: "Find", data: {} })).toBe("other");
  });

  it("classifies Claude search tools ahead of their broad file-read request kind", () => {
    for (const toolName of ["Glob", "Grep", "LS"]) {
      expect(classifyToolActivity({ requestKind: "file-read", data: { toolName } })).toBe("search");
    }
    expect(classifyToolActivity({ requestKind: "file-read", data: { toolName: "Read" } })).toBe(
      "read",
    );
  });

  it("keeps the previous rawInput when a later update is empty and replaces it otherwise", () => {
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: {}, kind: "read" }),
    ).toEqual({
      rawInput: { path: "src/a.ts" },
      kind: "read",
    });
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: { startLine: 4 } }),
    ).toEqual({ rawInput: { startLine: 4 } });
  });

  it("recognizes computer-use REPL calls before result metadata exists", () => {
    expect(dynamicToolSurface("cua_repl.js", {})).toBe("computer");
    for (const name of ["node_repl.js", "js"]) {
      expect(dynamicToolSurface(name, { code: "await sky.get_app_state(app);" })).toBe("computer");
      expect(dynamicToolSurface(name, { code: "const sky = await import('@oai/sky');" })).toBe(
        "computer",
      );
      expect(dynamicToolSurface(name, { code: "await fs.readFile(path);" })).toBeUndefined();
    }
    expect(dynamicToolSurface("github.js", { code: "await sky.click(app);" })).toBeUndefined();
  });
});

// fork: labels take an optional translator; without one the English is unchanged.
describe("tool labels", () => {
  const bracket = (source: string, params?: Readonly<Record<string, string | number>>) =>
    `[${source}]${params ? JSON.stringify(params) : ""}`;

  it.each([
    [["src/a.ts", 0], "Read src/a.ts", '[Read {path}]{"path":"src/a.ts"}'],
    [
      ["src/a.ts", 2],
      "Read src/a.ts +2 more",
      '[Read {path} +{count} more]{"path":"src/a.ts","count":2}',
    ],
    [["  ", 0], "Read file", "[Read file]"],
    [["", 3], "Read file +3 more", '[Read file +{count} more]{"count":3}'],
  ] as const)("read label %j", ([path, extra], english, translated) => {
    expect(formatReadToolLabel(path, extra)).toBe(english);
    expect(formatReadToolLabel(path, extra, bracket)).toBe(translated);
  });

  it.each([
    [{ query: "TODO", path: "src/lib" }, "Searched TODO in lib", "Searched {query} in {target}"],
    [
      { glob: "*.ts", path: "src" },
      "Searched files *.ts in src",
      "Searched files {glob} in {target}",
    ],
    [{ glob: "*.ts" }, "Searched files *.ts", "Searched files {glob}"],
    [{ query: "TODO" }, "Searched TODO", "Searched {query}"],
    [{ path: "src" }, "Searched in src", "Searched in {target}"],
  ] as const)("search label %j", (input, english, source) => {
    expect(formatSearchToolLabel({ input })).toBe(english);
    expect(formatSearchToolLabel({ input }, bracket)?.startsWith(`[${source}]`)).toBe(true);
  });
});
