import { describe, expect, it } from "vite-plus/test";

import {
  changelogItems,
  describeSubject,
  previousForkTag,
  renderChangelogDraft,
  type ChangelogCommit,
} from "./fork-changelog-draft.ts";

const commit = (subject: string, mergedSubjects: ReadonlyArray<string> = []): ChangelogCommit => ({
  sha: "a".repeat(40),
  isMerge: mergedSubjects.length > 0 || subject.startsWith("Merge"),
  subject,
  mergedSubjects,
});
const context = { upstreamVersion: "0.1.11", previousUpstreamVersion: "0.1.11" };

describe("describeSubject", () => {
  it.each([
    ["feat(web): add a thing", { section: "features", text: "Add a thing (web)" }],
    ["fix: stop crashing", { section: "fixes", text: "Stop crashing" }],
    ["fix(server)!: break less", { section: "fixes", text: "Break less (server)" }],
    ["docs(fork): explain it", { section: "other", text: "Explain it (fork)" }],
    ["tidy things", { section: "other", text: "Tidy things" }],
  ] as const)("reads %s", (subject, expected) => {
    expect(describeSubject(subject)).toEqual(expected);
  });
});

describe("changelogItems", () => {
  it("takes a merge's own summary and files it under its strongest branch commit", () => {
    expect(
      changelogItems(
        [
          commit("Merge branch 't3/win': releases ship a Windows installer", [
            "docs(install): a note",
            "feat(release): build a Windows installer",
          ]),
          commit("Merge branch 't3/x': tidy", ["chore: tidy"]),
        ],
        context,
      ),
    ).toEqual([
      { section: "features", text: "Releases ship a Windows installer" },
      { section: "other", text: "Tidy" },
    ]);
  });

  it("lists a bare merge by the commits it brought in", () => {
    expect(
      changelogItems([commit("Merge branch 't3/x'", ["fix(web): one", "feat(web): two"])], context),
    ).toEqual([
      { section: "fixes", text: "One (web)" },
      { section: "features", text: "Two (web)" },
    ]);
  });

  it("collapses every upstream sync into one item that names the newest", () => {
    const items = changelogItems(
      [
        commit("fix(i18n): after the upstream merge"),
        commit("Merge upstream T3 Code up to 9cc4018c75abcdef, adopting GT"),
        commit("Merge upstream T3 Code up to 1111111111, older"),
      ],
      context,
    );
    expect(items.filter((item) => item.section === "upstream")).toEqual([
      { section: "upstream", text: "Synced upstream T3 Code to 9cc4018c75" },
    ]);
    expect(items).toHaveLength(2);
  });

  it("names the upstream version when it moved", () => {
    expect(
      changelogItems([commit("Merge upstream T3 Code up to 9cc4018c75")], {
        upstreamVersion: "0.1.12",
        previousUpstreamVersion: "0.1.11",
      }),
    ).toEqual([{ section: "upstream", text: "Synced upstream T3 Code to 0.1.12 9cc4018c75" }]);
  });

  it("drops a repeated line", () => {
    expect(changelogItems([commit("fix: same"), commit("fix: same")], context)).toHaveLength(1);
  });
});

describe("renderChangelogDraft", () => {
  it("writes both languages, leaves out empty groups and marks every Chinese item", () => {
    const draft = renderChangelogDraft([
      { section: "fixes", text: "Fixed a thing" },
      { section: "features", text: "Added a thing" },
    ]);
    expect(draft).toBe(
      [
        "## 中文",
        "",
        "### 新功能",
        "",
        "- TODO(zh): Added a thing",
        "",
        "### 修复",
        "",
        "- TODO(zh): Fixed a thing",
        "",
        "## English",
        "",
        "### Features",
        "",
        "- Added a thing",
        "",
        "### Fixes",
        "",
        "- Fixed a thing",
        "",
      ].join("\n"),
    );
  });
});

describe("previousForkTag", () => {
  it("is the highest published fork tag below the version, compared numerically", () => {
    const tags = [
      "v0.1.11-1.9",
      "v0.1.11-1.10",
      "v0.1.11",
      "v0.1.12-nightly.20261121.5024",
      "v0.0.0-ci.3",
      "v0.1.12-1.0",
    ];
    expect(previousForkTag(tags, "0.1.12-1.1")).toBe("v0.1.12-1.0");
    expect(previousForkTag(tags, "0.1.12-1.0")).toBe("v0.1.11-1.10");
    expect(previousForkTag(["v0.1.11"], "0.1.11-1.0")).toBeUndefined();
    expect(previousForkTag(tags, "0.0.0-ci.5")).toBe("v0.1.12-1.0");
  });

  it("skips releases that went out without a changelog, back to the oldest fork tag", () => {
    const tags = ["v0.1.11-1.0", "v0.1.11-1.1", "v0.1.11-1.6", "v0.1.11-1.7"];
    const written = (versions: ReadonlyArray<string>) => (version: string) =>
      versions.includes(version);
    expect(previousForkTag(tags, "0.1.11-1.8", written(["0.1.11-1.7"]))).toBe("v0.1.11-1.7");
    expect(previousForkTag(tags, "0.1.11-1.8", written(["0.1.11-1.1"]))).toBe("v0.1.11-1.1");
    expect(previousForkTag(tags, "0.1.11-1.7", written([]))).toBe("v0.1.11-1.0");
  });
});
