import {
  ProjectId,
  type PullRequestSummary,
  SourceControlProviderKind,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";
import { describe, expect, it } from "vite-plus/test";

import {
  knownPullRequestSummary,
  presentThreadLinkedPullRequests,
  presentThreadPr,
  rememberBounded,
  resolveThreadPrSource,
} from "./thread-pr-presentation";

const t = translatorFor("en");

function linkedPr(
  number: number,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-09-08T00:00:00.000Z",
    stack: null,
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch: `change-${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-09-08T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("presentThreadLinkedPullRequests", () => {
  it("uses the top of a derived stack even when its bottom was linked later", () => {
    const bottom = linkedPr(1, { linkedAt: "2026-09-09T00:00:00.000Z" });
    const top = linkedPr(2);
    expect(
      presentThreadLinkedPullRequests(
        [
          bottom,
          {
            ...top,
            snapshot: { ...top.snapshot!, baseBranch: "change-1" },
          },
        ],
        t,
      ),
    ).toMatchObject({ kind: "stack", label: "2", number: 2, url: top.url });
  });

  it("names a single link with its host's term", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(7)], t)?.accessibilityLabel).toBe(
      "#7 pull request open",
    );
    expect(
      presentThreadLinkedPullRequests(
        [
          linkedPr(7, {
            host: "gitlab.com",
            repository: "t3tools/t3code",
            url: "https://gitlab.com/t3tools/t3code/-/merge_requests/7",
          }),
        ],
        t,
      )?.accessibilityLabel,
    ).toBe("#7 merge request open");
  });

  it("follows the translator it is given", async () => {
    await loadUiCatalog("zh-Hans");
    expect(
      presentThreadLinkedPullRequests([linkedPr(7)], translatorFor("zh-Hans"))?.accessibilityLabel,
    ).toBe("#7 PR 开放");
  });
});

describe("presentThreadPr", () => {
  const pr = {
    number: 42,
    title: "Change",
    url: "https://github.com/t3tools/t3code/pull/42",
    baseRef: "main",
    headRef: "change",
    state: "open",
    isDraft: true,
  } as const;

  it("translates the spoken state and keeps the data fields", async () => {
    expect(presentThreadPr(pr, null, t).accessibilityLabel).toBe("#42 pull request draft");
    await loadUiCatalog("zh-Hans");
    expect(presentThreadPr(pr, null, translatorFor("zh-Hans"))).toMatchObject({
      number: 42,
      state: "open",
      isDraft: true,
      accessibilityLabel: "#42 PR 草稿",
    });
  });
});

describe("resolveThreadPrSource compatibility", () => {
  const legacyRef = {
    projectId: ProjectId.make("project"),
    repository: "t3tools/t3code",
    number: 1,
    url: "https://github.com/t3tools/t3code/pull/1",
  };
  const branchRef = { ...legacyRef, number: 2, url: "https://github.com/t3tools/t3code/pull/2" };

  it("polls the stored reference before the server config loads", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        false,
        t,
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("uses snapshots without polling once the server config loads", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        true,
        t,
      ),
    ).toMatchObject({ linkedPresentation: { number: 3 }, pullRequestRef: null });
  });

  it("does not revive a removed modern link from the compatibility reference", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        true,
        t,
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: branchRef });
  });

  it("does not poll when a modern link is waiting for its first snapshot", () => {
    expect(
      resolveThreadPrSource(
        {
          pullRequests: [linkedPr(3, { snapshot: null })],
          linkedPullRequest: legacyRef,
          branchPullRequest: branchRef,
        },
        true,
        t,
      ),
    ).toMatchObject({ linkedPresentation: { number: 3, state: null }, pullRequestRef: null });
  });
});

describe("knownPullRequestSummary", () => {
  it("seeds from the newest summary of the same pull request, never another's", () => {
    const projectId = ProjectId.make("project");
    const link = linkedPr(7);
    const threads = [
      {
        projectId,
        pullRequests: [
          { ...link, snapshot: { ...link.snapshot!, updatedAt: "2026-09-08T00:00:00.000Z" } },
        ],
      },
    ];
    const listed: PullRequestSummary = {
      provider: SourceControlProviderKind.make("github"),
      projectId,
      repository: "t3tools/t3code",
      number: 7,
      title: "Listed title",
      url: "https://github.com/t3tools/t3code/pull/7",
      state: "open",
      headBranch: "change-7",
      baseBranch: "main",
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    const lookup = (host: string, number: number, summaries = [listed]) =>
      knownPullRequestSummary({ host, repository: "t3tools/t3code", number }, threads, summaries);

    expect(lookup("github.com", 7, [])?.title).toBe("Change 7");
    expect(lookup("github.com", 7)?.title).toBe("Listed title");
    expect(lookup("github.com", 8)).toBeUndefined();
    expect(lookup("gitlab.com", 7)).toBeUndefined();

    const sameVersion = { ...listed, updatedAt: "2026-09-08T00:00:00.000Z" };
    const syncedAt = Date.parse(link.snapshot!.syncedAt);
    expect(lookup("github.com", 7, [{ ...sameVersion, observedAt: syncedAt - 1 }])?.title).toBe(
      "Change 7",
    );
    expect(lookup("github.com", 7, [{ ...sameVersion, observedAt: syncedAt + 1 }])?.title).toBe(
      "Listed title",
    );
  });
});

describe("rememberBounded", () => {
  it("moves a re-answered entry to the newest slot and evicts the oldest past the limit", () => {
    let snapshots: ReadonlyMap<string, number> = new Map();
    snapshots = rememberBounded(snapshots, "a", 1, 2);
    snapshots = rememberBounded(snapshots, "b", 2, 2);
    snapshots = rememberBounded(snapshots, "a", 3, 2);
    snapshots = rememberBounded(snapshots, "c", 4, 2);
    expect([...snapshots]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
  });
});
