import {
  MAX_PROMPT_SHORTCUT_NAME_LENGTH,
  MAX_PROMPT_SHORTCUTS,
  MAX_PROMPT_SHORTCUTS_TOTAL_CONTENT_LENGTH,
  PROMPT_SHORTCUT_NAME_PATTERN,
  type PromptShortcut,
  type PromptShortcutChange,
} from "@t3tools/contracts/settings";

import { replaceComposerContextReferences } from "./composerContextReferences.ts";
import {
  formatProviderSkillDisplayName,
  SKILL_TOKEN_REGEX,
  type InlineSkill,
} from "./inlineSkills.ts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "./searchRanking.ts";

const PROMPT_SHORTCUT_MENU_LIMIT = 50;
const GHOST_SUMMARY_LENGTH = 48;
/** Below this many characters a query only matches names that start with it: two letters fuzzy-match everything. */
const MIN_LOOSE_MATCH_QUERY_LENGTH = 3;

/** Names are stored lowercase; `;SK` finds `sk`. */
export function normalizePromptShortcutName(input: string): string {
  return input.trim().toLowerCase();
}

export type PromptShortcutNameProblem = "empty" | "format" | "too-long" | "duplicate";

/** `existingNames` holds the other shortcuts' names, so an edit does not collide with itself. */
export function validatePromptShortcutName(
  input: string,
  existingNames: Iterable<string>,
): PromptShortcutNameProblem | null {
  const name = normalizePromptShortcutName(input);
  if (name.length === 0) return "empty";
  if (!PROMPT_SHORTCUT_NAME_PATTERN.test(name)) return "format";
  if (name.length > MAX_PROMPT_SHORTCUT_NAME_LENGTH) return "too-long";
  for (const existing of existingNames) {
    if (existing === name) return "duplicate";
  }
  return null;
}

function scorePromptShortcut(shortcut: PromptShortcut, query: string): number | null {
  const scores = [
    scoreQueryMatch({
      value: shortcut.name,
      query,
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 40,
      includesBase: 80,
      fuzzyBase: 150,
      boundaryMarkers: ["-"],
    }),
    shortcut.title === null
      ? null
      : scoreQueryMatch({
          value: shortcut.title.trim().toLowerCase(),
          query,
          exactBase: 55,
          prefixBase: 60,
          boundaryBase: 70,
          includesBase: 100,
        }),
  ].filter((score): score is number => score !== null);
  return scores.length === 0 ? null : Math.min(...scores);
}

/** The typed query is the start of the shortcut's name: the one match Enter may expand unasked. */
export function isPromptShortcutNamePrefixMatch(shortcut: PromptShortcut, query: string): boolean {
  return shortcut.name.startsWith(normalizeSearchQuery(query));
}

/**
 * Candidates for `;query`. Names the query starts come first (an empty query lists them all);
 * from three characters on, word-boundary, title and fuzzy matches follow, always below them.
 * A query nothing matches returns an empty list, which keeps the menu closed.
 */
export function matchPromptShortcuts(
  shortcuts: ReadonlyArray<PromptShortcut>,
  query: string,
  limit = PROMPT_SHORTCUT_MENU_LIMIT,
): PromptShortcut[] {
  const normalized = normalizeSearchQuery(query);
  const prefixMatches = shortcuts
    .filter((shortcut) => shortcut.name.startsWith(normalized))
    .sort(
      (left, right) =>
        Number(right.name === normalized) - Number(left.name === normalized) ||
        left.name.localeCompare(right.name),
    )
    .slice(0, limit);
  if (normalized.length < MIN_LOOSE_MATCH_QUERY_LENGTH || prefixMatches.length >= limit) {
    return prefixMatches;
  }
  const ranked: Array<{ item: PromptShortcut; score: number; tieBreaker: string }> = [];
  for (const shortcut of shortcuts) {
    if (shortcut.name.startsWith(normalized)) continue;
    const score = scorePromptShortcut(shortcut, normalized);
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      { item: shortcut, score, tieBreaker: shortcut.name },
      limit - prefixMatches.length,
    );
  }
  return [...prefixMatches, ...ranked.map((entry) => entry.item)];
}

/** For the readable helpers: the display name of a skill the provider offers, nothing for others. */
export function promptShortcutSkillNames(
  skills: ReadonlyArray<InlineSkill>,
): (skillName: string) => string | undefined {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return (skillName) => {
    const skill = byName.get(skillName);
    return skill ? formatProviderSkillDisplayName(skill) : undefined;
  };
}

const MARKDOWN_LINK_REGEX = /!?\[((?:[^\]\\]|\\.)*)\]\([^)\s]*\)/g;

/**
 * A saved prompt as a person would read it in a menu: a file link as its file name, a context
 * reference as its label, `$skill` as the skill's name (its display name when `skillDisplayName`
 * knows it). Chips cannot render there, so the raw text would show markup.
 */
export function promptShortcutReadableText(
  content: string,
  skillDisplayName?: (skillName: string) => string | undefined,
): string {
  const withoutContext = replaceComposerContextReferences(content, (reference) => reference.label);
  const withoutLinks = withoutContext.replace(MARKDOWN_LINK_REGEX, (_match, label: string) =>
    label.replace(/\\(.)/g, "$1"),
  );
  return withoutLinks.replace(
    SKILL_TOKEN_REGEX,
    (_match, lead: string, name: string) => `${lead}${skillDisplayName?.(name) ?? name}`,
  );
}

/** The first non-empty line of a saved prompt, readable and flattened to one short line. */
export function promptShortcutSummary(
  content: string,
  maxLength = GHOST_SUMMARY_LENGTH,
  skillDisplayName?: (skillName: string) => string | undefined,
): string {
  const readable = promptShortcutReadableText(content, skillDisplayName);
  const line = readable.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "";
  const flat = line.trim().replace(/\s+/g, " ");
  if (flat.length <= maxLength) return flat;
  const clipped = flat
    .slice(0, maxLength - 1)
    .replace(/[\s\p{P}]+$/u, "")
    .trimEnd();
  return `${clipped}…`;
}

/**
 * Gray text after the caret for a name-prefix match: what is left of its name, then a one-line
 * peek at the content. Null for any other match, which Enter would not expand either.
 */
export function promptShortcutGhostText(
  shortcut: PromptShortcut,
  query: string,
  skillDisplayName?: (skillName: string) => string | undefined,
): string | null {
  if (!isPromptShortcutNamePrefixMatch(shortcut, query)) return null;
  const rest = shortcut.name.slice(normalizeSearchQuery(query).length);
  const summary = promptShortcutSummary(shortcut.content, GHOST_SUMMARY_LENGTH, skillDisplayName);
  if (summary === "") return rest === "" ? null : rest;
  // oxlint-disable-next-line t3code/no-em-dash-copy -- the ghost text's separator is part of the feature's design
  return rest === "" ? ` ${summary}` : `${rest} — ${summary}`;
}

/**
 * What an expansion inserts: the saved text with one space after it, unless it already ends in
 * whitespace. A `$skill` or `@file` at the very end only becomes a chip once a space follows it, and
 * the caret should land where typing continues, not against the last word.
 */
export function promptShortcutInsertionText(content: string): string {
  return /\s$/.test(content) ? content : `${content} `;
}

export type PromptShortcutChangeProblem = "name-taken" | "limit" | "too-large";

function totalContentLength(shortcuts: ReadonlyArray<PromptShortcut>): number {
  return shortcuts.reduce((total, shortcut) => total + shortcut.content.length, 0);
}

/**
 * Applies edits in order. An upsert may not reuse another shortcut's name, add past the list cap or
 * grow the contents past the total cap; the first such edit stops everything and reports why, so a
 * refused write changes nothing. Removing an id that is gone is not an error: the goal is met.
 */
export function applyPromptShortcutChanges(
  current: ReadonlyArray<PromptShortcut>,
  changes: ReadonlyArray<PromptShortcutChange>,
): { shortcuts: ReadonlyArray<PromptShortcut>; problem: PromptShortcutChangeProblem | null } {
  let shortcuts = current;
  for (const change of changes) {
    if (change.kind === "remove") {
      shortcuts = shortcuts.filter((entry) => entry.id !== change.id);
      continue;
    }
    const { shortcut } = change;
    const existing = shortcuts.find((entry) => entry.id === shortcut.id);
    if (shortcuts.some((entry) => entry.id !== shortcut.id && entry.name === shortcut.name)) {
      return { shortcuts: current, problem: "name-taken" };
    }
    if (existing === undefined && shortcuts.length >= MAX_PROMPT_SHORTCUTS) {
      return { shortcuts: current, problem: "limit" };
    }
    const next =
      existing === undefined
        ? [...shortcuts, shortcut]
        : shortcuts.map((entry) => (entry.id === shortcut.id ? shortcut : entry));
    const total = totalContentLength(next);
    if (
      total > MAX_PROMPT_SHORTCUTS_TOTAL_CONTENT_LENGTH &&
      total > totalContentLength(shortcuts)
    ) {
      return { shortcuts: current, problem: "too-large" };
    }
    shortcuts = next;
  }
  return { shortcuts, problem: null };
}

/** For the dialog: whether the other shortcuts leave room for `content`. */
export function promptShortcutsHaveRoomFor(
  others: ReadonlyArray<PromptShortcut>,
  contentLength: number,
): boolean {
  return totalContentLength(others) + contentLength <= MAX_PROMPT_SHORTCUTS_TOTAL_CONTENT_LENGTH;
}
