// @effect-diagnostics nodeBuiltinImport:off processEnv:off - A dependency-free release step: it reads git and writes one file.
// T3 Extend: draft docs/fork/changelog/<version>.md from the first-parent history since the previous
// published fork tag. The draft has English items and a marked placeholder per Chinese item; a person rewrites both
// sections in user-facing language before tagging. See docs/fork/release.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { compareReleaseVersions } from "./fork-release-version.ts";

export type ChangelogSection = "features" | "fixes" | "upstream" | "other";

export interface ChangelogCommit {
  readonly sha: string;
  /** More than one parent. */
  readonly isMerge: boolean;
  readonly subject: string;
  /** For a merge: the subjects of the commits it brought in, newest first, merges excluded. */
  readonly mergedSubjects: ReadonlyArray<string>;
}

export interface ChangelogItem {
  readonly section: ChangelogSection;
  readonly text: string;
}

const SECTION_TITLES: ReadonlyArray<{
  readonly section: ChangelogSection;
  readonly zh: string;
  readonly en: string;
}> = [
  { section: "features", zh: "新功能", en: "Features" },
  { section: "fixes", zh: "修复", en: "Fixes" },
  { section: "upstream", zh: "上游同步", en: "Upstream" },
  { section: "other", zh: "其他", en: "Other" },
];

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/u;
const FORK_TAG = /^v\d+\.\d+\.\d+-\d+\.\d+$/u;
const UPSTREAM_MERGE = /^Merge\b.*\bupstream\b/iu;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function sectionOfType(type: string): ChangelogSection {
  if (type === "feat") return "features";
  if (type === "fix") return "fixes";
  return "other";
}

/** `feat(web): add a thing` → the section and `Add a thing (web)`. */
export function describeSubject(subject: string): ChangelogItem {
  const match = CONVENTIONAL.exec(subject.trim());
  if (match === null) return { section: "other", text: capitalize(subject.trim()) };
  const [, type = "", scope, text = ""] = match;
  return {
    section: sectionOfType(type),
    text: `${capitalize(text.trim())}${scope ? ` (${scope})` : ""}`,
  };
}

/** The strongest section among the commits a merge brought in: a feature beats a fix beats the rest. */
function sectionOfMerge(mergedSubjects: ReadonlyArray<string>): ChangelogSection {
  const sections = mergedSubjects.map((subject) => describeSubject(subject).section);
  if (sections.includes("features")) return "features";
  if (sections.includes("fixes")) return "fixes";
  return "other";
}

function describeMerge(commit: ChangelogCommit): ReadonlyArray<ChangelogItem> {
  // `Merge branch 'x': what it does` carries its own summary. A bare git merge subject does not, so the
  // branch's own commits stand in for it.
  const summary = /^Merge [^:]+:\s*(.+)$/u.exec(commit.subject)?.[1];
  if (summary !== undefined) {
    return [{ section: sectionOfMerge(commit.mergedSubjects), text: capitalize(summary.trim()) }];
  }
  return commit.mergedSubjects.map(describeSubject);
}

/**
 * One item per change, newest first. Every upstream sync collapses into a single "synced" item, however
 * many merge commits and follow-up fixes it took.
 */
export function changelogItems(
  commits: ReadonlyArray<ChangelogCommit>,
  context: { readonly upstreamVersion: string; readonly previousUpstreamVersion?: string },
): ReadonlyArray<ChangelogItem> {
  const items: Array<ChangelogItem> = [];
  let upstreamSync: ChangelogItem | undefined;
  for (const commit of commits) {
    if (commit.isMerge && UPSTREAM_MERGE.test(commit.subject)) {
      if (upstreamSync === undefined) {
        const ref = /\b([0-9a-f]{10,40})\b/u.exec(commit.subject)?.[1];
        const moved = context.upstreamVersion !== context.previousUpstreamVersion;
        const target = [moved ? context.upstreamVersion : undefined, ref?.slice(0, 10)]
          .filter((part) => part !== undefined)
          .join(" ");
        upstreamSync = {
          section: "upstream",
          text: target === "" ? "Synced upstream T3 Code" : `Synced upstream T3 Code to ${target}`,
        };
        items.push(upstreamSync);
      }
      continue;
    }
    items.push(...(commit.isMerge ? describeMerge(commit) : [describeSubject(commit.subject)]));
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.section}\n${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `## 中文` with one marked placeholder per item, then `## English`; empty sections are left out. */
export function renderChangelogDraft(items: ReadonlyArray<ChangelogItem>): string {
  const render = (language: "zh" | "en") =>
    SECTION_TITLES.flatMap(({ section, zh, en }) => {
      const inSection = items.filter((item) => item.section === section);
      if (inSection.length === 0) return [];
      return [
        `### ${language === "zh" ? zh : en}`,
        "",
        ...inSection.map((item) =>
          language === "zh" ? `- TODO(zh): ${item.text}` : `- ${item.text}`,
        ),
        "",
      ];
    });
  return ["## 中文", "", ...render("zh"), "## English", "", ...render("en")].join("\n");
}

/**
 * The highest published fork tag below `version`, among tags reachable from the commit being released.
 * A test build (`-ci.N`) has no place in the order, so it is drafted against the highest tag.
 */
export function previousForkTag(tags: ReadonlyArray<string>, version: string): string | undefined {
  const testBuild = /-ci\.\d+$/u.test(version);
  return tags
    .filter((tag) => FORK_TAG.test(tag))
    .filter((tag) => testBuild || compareReleaseVersions(tag.slice(1), version) < 0)
    .toSorted((left, right) => compareReleaseVersions(right.slice(1), left.slice(1)))[0];
}

function git(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
}

function readCommits(from: string): ReadonlyArray<ChangelogCommit> {
  const records = git(["log", "--first-parent", "--format=%H%x1f%P%x1f%s%x1e", `${from}..HEAD`])
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean);
  return records.map((record) => {
    const [sha = "", parents = "", subject = ""] = record.split("\x1f");
    const [firstParent = "", ...merged] = parents.split(" ").filter(Boolean);
    const isMerge = merged.length > 0;
    return {
      sha,
      isMerge,
      subject,
      mergedSubjects: isMerge
        ? git(["log", "--no-merges", "--format=%s", `${firstParent}..${merged[0]}`])
            .split("\n")
            .filter(Boolean)
        : [],
    };
  });
}

/** The draft for `version`, against `since` or the previous fork tag reachable from HEAD. */
export function draftChangelog(input: { readonly version: string; readonly since?: string }): {
  readonly draft: string;
  readonly since: string;
} {
  const since =
    input.since ??
    previousForkTag(git(["tag", "--merged", "HEAD", "--list", "v*"]).split("\n"), input.version);
  if (since === undefined) {
    throw new Error("No earlier fork tag is reachable from HEAD; pass --since <tag>.");
  }
  const draft = renderChangelogDraft(
    changelogItems(readCommits(since), {
      upstreamVersion: input.version.split("-")[0]!,
      previousUpstreamVersion: since.replace(/^v/u, "").split("-")[0],
    }),
  );
  return { draft, since };
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      version: { type: "string" },
      since: { type: "string" },
      out: { type: "string" },
      stdout: { type: "boolean", default: false },
    },
  });
  const version = values.version?.replace(/^v/u, "") ?? "";
  if (!/^\d+\.\d+\.\d+-(\d+\.\d+|ci\.\d+)$/u.test(version)) {
    process.stderr.write(
      "Usage: fork-changelog-draft.ts --version <upstream>-<fork> [--since <tag>] [--out <file>] [--stdout]\n",
    );
    process.exit(2);
  }
  try {
    const { draft, since } = draftChangelog({
      version,
      ...(values.since ? { since: values.since } : {}),
    });
    if (values.stdout) {
      process.stdout.write(`${draft}\n`);
    } else {
      const target = NodePath.resolve(
        values.out ?? NodePath.join(import.meta.dirname, "../docs/fork/changelog", `${version}.md`),
      );
      if (NodeFS.existsSync(target)) {
        throw new Error(`${target} exists; it is never overwritten. Edit it by hand.`);
      }
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, `${draft}\n`);
      process.stdout.write(
        `Wrote ${target} from ${since}..HEAD. Finish both languages, then remove every TODO.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
