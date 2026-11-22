import { describe, expect, it } from "vite-plus/test";

import { resolveReleaseChangelog } from "./fork-release-changelog.ts";

const FINISHED = "## 中文\n\n- 完成\n\n## English\n\n- Done\n";
const resolve = (input: { publish: boolean; file: string | undefined }) =>
  resolveReleaseChangelog({ version: "0.1.11-1.7", ...input, draft: () => "DRAFT" });

describe("resolveReleaseChangelog", () => {
  it("publishes a finished changelog as written", () => {
    expect(resolve({ publish: true, file: FINISHED })).toBe(FINISHED);
  });

  it.each([
    ["is missing", undefined, /is missing/u],
    ["still has a marker", FINISHED.replace("完成", "TODO(zh): done"), /still has a TODO/u],
    ["has one language only", "## English\n\n- Done\n", /no "## 中文" section/u],
  ])("refuses to publish a changelog that %s", (_case, file, message) => {
    expect(() => resolve({ publish: true, file })).toThrow(message);
  });

  it("lets a test build use the file, even unfinished, or fall back to the draft", () => {
    expect(resolve({ publish: false, file: "## 中文\nTODO(zh): x" })).toContain("TODO(zh)");
    expect(resolve({ publish: false, file: undefined })).toBe("DRAFT");
  });
});
