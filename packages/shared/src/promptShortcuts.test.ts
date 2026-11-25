import type { PromptShortcut } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  matchPromptShortcuts,
  promptShortcutGhostText,
  promptShortcutSummary,
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
  it("lists everything by name for an empty query", () => {
    expect(matchPromptShortcuts(shortcuts, "").map((entry) => entry.name)).toEqual([
      "fix-ci",
      "review",
      "sum",
      "summary-long",
    ]);
  });

  it("ranks an exact name, then name prefixes, then other matches, ignoring case", () => {
    expect(matchPromptShortcuts(shortcuts, "SUM").map((entry) => entry.name)).toEqual([
      "sum",
      "summary-long",
    ]);
    expect(matchPromptShortcuts(shortcuts, "ci").map((entry) => entry.name)).toEqual(["fix-ci"]);
  });

  it("finds a shortcut by its title or a fuzzy name, and returns nothing for no match", () => {
    expect(matchPromptShortcuts(shortcuts, "tldr").map((entry) => entry.name)).toEqual(["sum"]);
    expect(matchPromptShortcuts(shortcuts, "rvw").map((entry) => entry.name)).toEqual(["review"]);
    expect(matchPromptShortcuts(shortcuts, "zzz")).toEqual([]);
  });

  it("honors the limit", () => {
    expect(matchPromptShortcuts(shortcuts, "", 2)).toHaveLength(2);
  });
});

describe("promptShortcutGhostText", () => {
  it("shows the rest of the name and the first line of the content", () => {
    expect(promptShortcutGhostText(shortcuts[0]!, "rev")).toBe("iew — Review this change");
    expect(promptShortcutGhostText(shortcuts[0]!, "REVIEW")).toBe(" — Review this change");
  });

  it("shows only the summary when the name is not a prefix match, and truncates it", () => {
    expect(promptShortcutGhostText(shortcuts[1]!, "tldr")).toBe(" — Summarize the thread");
    expect(promptShortcutSummary("x".repeat(100), 10)).toBe("xxxxxxxxx…");
    expect(promptShortcutSummary("\n\n  spaced   out \nsecond")).toBe("spaced out");
  });
});
