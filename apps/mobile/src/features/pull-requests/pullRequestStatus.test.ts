import type { PullRequestActivity, PullRequestCheck, PullRequestComment } from "@t3tools/contracts";
import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";
import { describe, expect, it } from "vite-plus/test";
import {
  normalizedReviewState,
  pullRequestChecksSummary,
  pullRequestReviewSummary,
  pullRequestStatus,
} from "./pullRequestStatus";

const t = translatorFor("en");
const author = { login: "julius", name: null, avatarUrl: null };
function review(state: string, at: string): PullRequestComment {
  return {
    id: `${state}:${at}`,
    kind: "review",
    author,
    body: "",
    createdAt: at,
    url: null,
    path: null,
    reviewState: state,
  };
}
function activity(
  comments: readonly PullRequestComment[],
): Pick<PullRequestActivity, "comments" | "commits"> {
  return { comments, commits: [] };
}
function check(status: PullRequestCheck["status"]): PullRequestCheck {
  return { name: status, status, url: null, description: null };
}

describe("mobile overview review status", () => {
  it("uses each reviewer's latest verdict even when history arrives out of order", () => {
    const result = pullRequestReviewSummary(
      { reviewers: [] },
      activity([
        review("CHANGES_REQUESTED", "2026-10-10T10:00:00Z"),
        review("APPROVED", "2026-10-10T09:00:00Z"),
      ]),
      t,
    );
    expect(result.title).toBe("Changes requested");
    expect(result.reviews).toHaveLength(1);
  });

  it("does not claim a dismissed approval or an approval preceding the latest commit", () => {
    const approved = review("APPROVED", "2026-10-10T09:00:00Z");
    expect(
      pullRequestReviewSummary(
        { reviewers: [] },
        activity([approved, review("DISMISSED", "2026-10-10T10:00:00Z")]),
        t,
      ).reviews,
    ).toEqual([]);
    const result = pullRequestReviewSummary(
      { reviewers: [author] },
      {
        comments: [approved],
        commits: [
          { oid: "abc123", messageHeadline: "Update", committedDate: "2026-10-10T10:00:00Z" },
        ],
      },
      t,
    );
    expect(result.title).toBe("Awaiting review");
  });

  it("keeps an approval when a later review only comments, and normalizes provider spelling", () => {
    const result = pullRequestReviewSummary(
      { reviewers: [] },
      activity([
        review("approved", "2026-10-10T09:00:00Z"),
        review("COMMENTED", "2026-10-10T10:00:00Z"),
      ]),
      t,
    );
    expect(result.title).toBe("Approved by julius");
    expect(result.reviews).toHaveLength(1);
    expect(
      pullRequestReviewSummary(
        { reviewers: [] },
        activity([review("changes-requested", "2026-10-10T11:00:00Z")]),
        t,
      ).title,
    ).toBe("Changes requested");
  });
});

describe("mobile review state spelling", () => {
  it("reads GitHub's uppercase and Bitbucket's or GitCafe's lowercase verdicts alike", () => {
    expect(normalizedReviewState("APPROVED")).toBe("APPROVED");
    expect(normalizedReviewState("approved")).toBe("APPROVED");
    expect(normalizedReviewState("CHANGES_REQUESTED")).toBe("CHANGES_REQUESTED");
    expect(normalizedReviewState("changes_requested")).toBe("CHANGES_REQUESTED");
    expect(normalizedReviewState("changes-requested")).toBe("CHANGES_REQUESTED");
    expect(normalizedReviewState("commented")).toBe("COMMENTED");
    expect(normalizedReviewState(null)).toBeUndefined();
  });
});

describe("mobile overview check status", () => {
  it("prioritizes failed checks while others are running", () => {
    expect(
      pullRequestChecksSummary(
        { checks: [check("success"), check("pending"), check("failure")] },
        t,
      ),
    ).toMatchObject({ title: "1 check failing", count: "1 of 3" });
    expect(
      pullRequestChecksSummary({ checks: [check("success"), check("cancelled")] }, t),
    ).toMatchObject({ title: "1 check failing", tint: "accent-danger-foreground" });
  });

  it("follows the translator it is given", async () => {
    await loadUiCatalog("zh-Hans");
    const checks = { checks: [check("success"), check("success")] };
    expect(pullRequestChecksSummary(checks, t).title).toBe("All checks passed");
    expect(pullRequestChecksSummary(checks, translatorFor("zh-Hans")).title).toBe(
      "所有检查都已通过",
    );
  });
});

describe("pullRequestStatus", () => {
  it("names the state as a state, not the Open action", async () => {
    expect(pullRequestStatus({ state: "open", isDraft: false }, t).label).toBe("Open");
    await loadUiCatalog("zh-Hans");
    const zh = translatorFor("zh-Hans");
    expect(pullRequestStatus({ state: "open", isDraft: false }, zh).label).toBe("开放");
    expect(pullRequestStatus({ state: "open", isDraft: true }, zh).label).toBe("草稿");
    expect(pullRequestStatus({ state: "closed", isDraft: false }, zh).label).toBe("已关闭");
  });
});
