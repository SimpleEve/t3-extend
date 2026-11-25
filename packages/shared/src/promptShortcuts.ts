import {
  MAX_PROMPT_SHORTCUT_NAME_LENGTH,
  PROMPT_SHORTCUT_NAME_PATTERN,
  type PromptShortcut,
} from "@t3tools/contracts/settings";

import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "./searchRanking.ts";

const PROMPT_SHORTCUT_MENU_LIMIT = 50;
const GHOST_SUMMARY_LENGTH = 48;

/** Names are stored lowercase; `:SK` finds `sk`. */
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

/**
 * Candidates for `:query`: a name prefix first, then word-boundary and title matches, then fuzzy
 * names. An empty query lists everything by name. A query nothing matches returns an empty list,
 * which keeps the menu closed.
 */
export function matchPromptShortcuts(
  shortcuts: ReadonlyArray<PromptShortcut>,
  query: string,
  limit = PROMPT_SHORTCUT_MENU_LIMIT,
): PromptShortcut[] {
  const normalized = normalizeSearchQuery(query);
  const ranked: Array<{ item: PromptShortcut; score: number; tieBreaker: string }> = [];
  for (const shortcut of shortcuts) {
    const score = normalized === "" ? 0 : scorePromptShortcut(shortcut, normalized);
    if (score === null) continue;
    insertRankedSearchResult(ranked, { item: shortcut, score, tieBreaker: shortcut.name }, limit);
  }
  return ranked.map((entry) => entry.item);
}

/** The first non-empty line of a saved prompt, flattened to one short line. */
export function promptShortcutSummary(content: string, maxLength = GHOST_SUMMARY_LENGTH): string {
  const line = content.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "";
  const flat = line.trim().replace(/\s+/g, " ");
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1).trimEnd()}…` : flat;
}

/**
 * Gray text after the caret for the top candidate: what is left of its name, then a one-line peek
 * at the content. Never the whole prompt.
 */
export function promptShortcutGhostText(shortcut: PromptShortcut, query: string): string {
  const typed = normalizePromptShortcutName(query);
  const rest = shortcut.name.startsWith(typed) ? shortcut.name.slice(typed.length) : "";
  const summary = promptShortcutSummary(shortcut.content);
  // oxlint-disable-next-line t3code/no-em-dash-copy -- the ghost text's separator is part of the feature's design
  return summary === "" ? rest : `${rest} — ${summary}`;
}
