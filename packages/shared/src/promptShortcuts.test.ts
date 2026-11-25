import type { PromptShortcut } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPromptShortcutChanges,
  isPromptShortcutNamePrefixMatch,
  matchPromptShortcuts,
  promptShortcutGhostText,
  promptShortcutInsertionText,
  promptShortcutReadableText,
  promptShortcutSkillNames,
  promptShortcutSummary,
  promptShortcutsHaveRoomFor,
  validatePromptShortcutName,
} from "./promptShortcuts.ts";

const shortcut = (name: string, content: string, title: string | null = null): PromptShortcut => ({
  id: name,
  name,
  title,
  content,
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
});

const shortcuts = [
  shortcut("review", "Review this change\nlook at tests", "Code review"),
  shortcut("sum", "Summarize the thread", "TLDR"),
  shortcut("summary-long", "Write a long summary"),
  shortcut("fix-ci", "Fix the failing CI job", "Make CI green"),
];

describe("validatePromptShortcutName", () => {
  it.each([
    ["", "empty"],
    ["  ", "empty"],
    ["has space", "format"],
    ["中文", "format"],
    ["a_b", "format"],
    ["a".repeat(33), "too-long"],
    ["SUM", "duplicate"],
    ["fresh-1", null],
    ["  Fresh ", null],
  ])("judges %j as %j", (input, problem) => {
    expect(validatePromptShortcutName(input, ["sum", "review"])).toBe(problem);
  });
});

describe("matchPromptShortcuts", () => {
  const names = (query: string, limit?: number) =>
    matchPromptShortcuts(shortcuts, query, limit).map((entry) => entry.name);

  it("lists everything by name for an empty query", () => {
    expect(names("")).toEqual(["fix-ci", "review", "sum", "summary-long"]);
  });

  it("ranks an exact name, then name prefixes, ignoring case", () => {
    expect(names("SUM")).toEqual(["sum", "summary-long"]);
    expect(names("re")).toEqual(["review"]);
  });

  it("matches only names that start with a one or two character query", () => {
    // "ci" is inside "fix-ci" and "co" fuzzy-matches the title "Code review": neither is offered.
    expect(names("ci")).toEqual([]);
    expect(names("co")).toEqual([]);
    expect(names("zz")).toEqual([]);
  });

  it("adds title, word and fuzzy matches from three characters, always below name prefixes", () => {
    expect(names("cod")).toEqual(["review"]);
    expect(names("tldr")).toEqual(["sum"]);
    expect(names("rvw")).toEqual(["review"]);
    expect(names("zzz")).toEqual([]);
    const withPrefix = [shortcut("code-owners", "Who owns this"), ...shortcuts];
    expect(matchPromptShortcuts(withPrefix, "cod").map((entry) => entry.name)).toEqual([
      "code-owners",
      "review",
    ]);
  });

  it("honors the limit", () => {
    expect(names("", 2)).toHaveLength(2);
  });

  it("tells whether a query starts a name", () => {
    expect(isPromptShortcutNamePrefixMatch(shortcuts[0]!, "RE")).toBe(true);
    expect(isPromptShortcutNamePrefixMatch(shortcuts[0]!, "")).toBe(true);
    expect(isPromptShortcutNamePrefixMatch(shortcuts[0]!, "cod")).toBe(false);
  });
});

describe("readable text", () => {
  const skillNames = promptShortcutSkillNames([
    { name: "babysit", displayName: "Babysit PRs" },
    { name: "plain" },
  ]);

  it("shows a skill by its display name, or its bare name when unknown", () => {
    expect(promptShortcutReadableText("Run $babysit then $plain and $unknown", skillNames)).toBe(
      "Run Babysit PRs then plain and unknown",
    );
    expect(promptShortcutReadableText("Costs $5 or $5k", skillNames)).toBe("Costs $5 or $5k");
  });

  it("shows a file link as its file name and a context reference as its label", () => {
    expect(promptShortcutReadableText("Read [a.ts](./src/a.ts) and [b.ts](src/b.ts)")).toBe(
      "Read a.ts and b.ts",
    );
    expect(
      promptShortcutReadableText("See [Fix flaky test](t3-context://thread/abc) now"),
    ).not.toContain("t3-context");
  });

  it("summarizes the first line without markup and without doubled punctuation", () => {
    expect(
      promptShortcutSummary("Open [a.ts](./src/a.ts) and use $babysit\nsecond", 80, skillNames),
    ).toBe("Open a.ts and use Babysit PRs");
    expect(promptShortcutSummary("Review the current changes and call out risks.", 40)).toBe(
      "Review the current changes and call out…",
    );
    expect(promptShortcutSummary("A sentence, that is. Long", 18)).toBe("A sentence, that…");
    expect(promptShortcutSummary("x".repeat(100), 10)).toBe("xxxxxxxxx…");
    expect(promptShortcutSummary("\n\n  spaced   out \nsecond")).toBe("spaced out");
  });
});

describe("promptShortcutGhostText", () => {
  it("shows the rest of the name and the first line of the content", () => {
    expect(promptShortcutGhostText(shortcuts[0]!, "rev")).toBe("iew — Review this change");
  });

  it("shows only the summary, set off by a space, for a full name", () => {
    expect(promptShortcutGhostText(shortcuts[0]!, "REVIEW")).toBe("\u00A0Review this change");
  });

  it("shows nothing unless the query starts the name", () => {
    expect(promptShortcutGhostText(shortcuts[1]!, "tldr")).toBeNull();
    expect(promptShortcutGhostText(shortcuts[0]!, "cod")).toBeNull();
  });

  it("reads the content as a person would", () => {
    const withSkill = shortcut("go", "Run $babysit");
    const skillNames = promptShortcutSkillNames([{ name: "babysit", displayName: "Babysit PRs" }]);
    expect(promptShortcutGhostText(withSkill, "g", skillNames)).toBe("o — Run Babysit PRs");
  });
});

describe("promptShortcutInsertionText", () => {
  it("ends the text with one space so a closing token can become a chip", () => {
    expect(promptShortcutInsertionText("Run $babysit")).toBe("Run $babysit ");
    expect(promptShortcutInsertionText("Run $babysit ")).toBe("Run $babysit ");
    expect(promptShortcutInsertionText("Line\n")).toBe("Line\n");
  });
});

describe("applyPromptShortcutChanges", () => {
  const upsert = (entry: PromptShortcut) => ({ kind: "upsert" as const, shortcut: entry });
  const remove = (id: string) => ({ kind: "remove" as const, id });

  it("adds, replaces and removes by id, in order", () => {
    const result = applyPromptShortcutChanges(shortcuts, [
      upsert(shortcut("new-one", "N")),
      upsert({ ...shortcuts[0]!, title: "Changed" }),
      remove("sum"),
      remove("not-there"),
    ]);
    expect(result.problem).toBeNull();
    expect(result.shortcuts.map((entry) => entry.name)).toEqual([
      "review",
      "summary-long",
      "fix-ci",
      "new-one",
    ]);
    expect(result.shortcuts[0]?.title).toBe("Changed");
  });

  it("refuses a name another shortcut holds, a full list and oversized contents, changing nothing", () => {
    const taken = applyPromptShortcutChanges(shortcuts, [
      upsert(shortcut("fresh", "F")),
      upsert({ ...shortcut("review", "Other"), id: "someone-else" }),
    ]);
    expect(taken).toEqual({ shortcuts, problem: "name-taken" });

    const full = Array.from({ length: 200 }, (_, index) => shortcut(`n-${index}`, "x"));
    expect(applyPromptShortcutChanges(full, [upsert(shortcut("one-more", "x"))]).problem).toBe(
      "limit",
    );

    const big = Array.from({ length: 20 }, (_, index) =>
      shortcut(`b-${index}`, "x".repeat(12_000)),
    );
    expect(applyPromptShortcutChanges(big, [upsert(shortcut("last", "x".repeat(20_000)))])).toEqual(
      { shortcuts: big, problem: "too-large" },
    );
    expect(promptShortcutsHaveRoomFor(big, 100)).toBe(true);
    expect(promptShortcutsHaveRoomFor(big, 20_000)).toBe(false);
  });
});
