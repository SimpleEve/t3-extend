import { describe, expect, it } from "vite-plus/test";

import {
  limitOutputRows,
  outputDirectoryTail,
  OUTPUT_ROW_LIMIT,
  outputFileDisplay,
  outputLinkDisplay,
  visibleOutputRows,
  workspacePreviewPath,
} from "./display.ts";

describe("workspacePreviewPath", () => {
  it.each([
    ["inside the workspace", "/work/app/src/a.ts", "/work/app", "src/a.ts"],
    ["the workspace root", "/work/app", "/work/app", null],
    ["a sibling folder", "/work/other/a.ts", "/work/app", null],
    ["outside, like /tmp", "/tmp/report.md", "/work/app", null],
    ["escaping with ..", "/work/app/../other/a.ts", "/work/app", null],
    ["no workspace", "/work/app/a.ts", undefined, null],
    ["a windows workspace", "C:\\work\\app\\a.ts", "c:\\work\\app", "a.ts"],
  ])("%s", (_name, path, root, expected) => {
    expect(workspacePreviewPath(path, root)).toBe(expected);
  });
});

describe("outputFileDisplay", () => {
  it.each([
    ["in the workspace", "/work/app/src/ui/a.ts", "/work/app", "a.ts", "src/ui"],
    ["at the workspace root", "/work/app/README.md", "/work/app", "README.md", ""],
    ["outside the workspace", "/tmp/out/report.md", "/work/app", "report.md", "/tmp/out"],
    ["without a workspace", "/tmp/report.md", undefined, "report.md", "/tmp"],
  ])("%s", (_name, path, root, name, directory) => {
    expect(outputFileDisplay(path, root)).toEqual({ name, directory });
  });
});

describe("outputLinkDisplay", () => {
  it.each([
    ["a bare origin", "http://localhost:3000", "localhost:3000", ""],
    ["a path", "https://abc.trycloudflare.com/app/x", "abc.trycloudflare.com", "/app/x"],
    ["a query", "http://192.168.1.2:5173/a?b=1", "192.168.1.2:5173", "/a?b=1"],
    ["not a url", "nope", "nope", ""],
  ])("%s", (_name, url, host, path) => {
    expect(outputLinkDisplay(url)).toEqual({ host, path });
  });
});

describe("visibleOutputRows", () => {
  const rows = (count: number) => Array.from({ length: count }, (_, index) => index);

  it.each([
    ["fewer than the limit", OUTPUT_ROW_LIMIT - 1, false, OUTPUT_ROW_LIMIT - 1, 0, false],
    ["exactly the limit", OUTPUT_ROW_LIMIT, false, OUTPUT_ROW_LIMIT, 0, false],
    ["exactly the limit, expanded", OUTPUT_ROW_LIMIT, true, OUTPUT_ROW_LIMIT, 0, false],
    ["one over", OUTPUT_ROW_LIMIT + 1, false, OUTPUT_ROW_LIMIT, 1, false],
    ["many", 40, false, OUTPUT_ROW_LIMIT, 40 - OUTPUT_ROW_LIMIT, false],
    ["many, expanded", 40, true, 40, 0, true],
  ])("%s", (_name, count, expanded, visible, hiddenCount, canCollapse) => {
    const result = visibleOutputRows(rows(count), expanded);
    expect(result.visible).toHaveLength(visible);
    expect(result.hiddenCount).toBe(hiddenCount);
    expect(result.canCollapse).toBe(canCollapse);
  });
});

describe("outputDirectoryTail", () => {
  it.each([
    ["two segments", "design/visual", 7],
    ["deeper", "src/components/ui", 3],
    ["a rooted folder", "/tmp/out", 4],
    ["windows", "C:\\work\\out", 4],
    ["one segment", "design", undefined],
    ["a rooted single segment", "/tmp", undefined],
    ["empty", "", undefined],
  ])("%s", (_name, directory, expected) => {
    expect(outputDirectoryTail(directory)).toBe(expected);
  });
});

describe("limitOutputRows", () => {
  it.each([
    ["under the limit", 3, 5, 3, 0],
    ["at the limit", 5, 5, 5, 0],
    ["over the limit", 12, 5, 5, 7],
    ["nothing", 0, 5, 0, 0],
  ])("%s", (_name, count, limit, listed, omitted) => {
    const result = limitOutputRows(
      Array.from({ length: count }, (_, index) => index),
      limit,
    );
    expect(result.rows).toHaveLength(listed);
    expect(result.omitted).toBe(omitted);
  });
});
