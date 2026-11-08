import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectViewFolders,
  flattenProjectViewFolders,
  groupThreadsByProject,
  groupThreadsByWorktree,
  hasMainCheckoutBadge,
  projectViewFolderThreadCount,
  resolveSidebarFolderDot,
  resolveSidebarThreadStatus,
  type ProjectViewRow,
  sidebarGroupCollapseKey,
  threadWorktreeGroupKey,
} from "./threadGrouping.ts";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const projectId = ProjectId.make("project-1");

function thread(
  id: string,
  options: {
    readonly sentAt: string;
    readonly worktreePath?: string | null;
    readonly branch?: string | null;
    readonly environmentId?: EnvironmentId;
  },
) {
  return {
    id: ThreadId.make(id),
    environmentId: options.environmentId ?? laptop,
    projectId,
    worktreePath: options.worktreePath ?? null,
    branch: options.branch ?? null,
    createdAt: "2026-10-01T00:00:00.000Z",
    latestRun: null,
    latestUserAuthoredMessageAt: options.sentAt,
  };
}

const ids = (threads: ReadonlyArray<{ readonly id: string }>) => threads.map((entry) => entry.id);

describe("groupThreadsByWorktree", () => {
  it("returns null when every thread is in the main checkout", () => {
    expect(
      groupThreadsByWorktree([
        thread("a", { sentAt: "2026-10-02T00:00:00.000Z", branch: "main" }),
        thread("b", { sentAt: "2026-10-03T00:00:00.000Z", worktreePath: "  " }),
      ]),
    ).toBeNull();
  });

  it("puts the main checkout first and orders linked worktrees by their newest send", () => {
    const groups = groupThreadsByWorktree([
      thread("old-wt", { sentAt: "2026-10-02T00:00:00.000Z", worktreePath: "/w/feature-a" }),
      thread("main", { sentAt: "2026-10-01T00:00:00.000Z", branch: "main" }),
      thread("new-wt", {
        sentAt: "2026-10-05T00:00:00.000Z",
        worktreePath: "/w/feature-b/",
        branch: "feature-b",
      }),
      thread("old-wt-2", { sentAt: "2026-10-04T00:00:00.000Z", worktreePath: "/w/feature-a" }),
    ]);
    expect(groups?.map((group) => [group.kind, group.label, ids(group.threads)])).toEqual([
      ["main", "main", ["main"]],
      ["linked", "feature-b", ["new-wt"]],
      // No branch: the worktree's folder name.
      ["linked", "feature-a", ["old-wt-2", "old-wt"]],
    ]);
  });

  it("labels a branchless main checkout null so the client names it", () => {
    const groups = groupThreadsByWorktree([
      thread("main", { sentAt: "2026-10-01T00:00:00.000Z" }),
      thread("wt", { sentAt: "2026-10-02T00:00:00.000Z", worktreePath: "C:\\w\\fix" }),
    ]);
    expect(groups?.map((group) => group.label)).toEqual([null, "fix"]);
    // Only a main checkout named by its branch needs the Main badge.
    expect(groups?.map(hasMainCheckoutBadge)).toEqual([false, false]);
    const branched = groupThreadsByWorktree([
      thread("main", { sentAt: "2026-10-01T00:00:00.000Z", branch: "feat/a" }),
      thread("wt", { sentAt: "2026-10-02T00:00:00.000Z", worktreePath: "/w/a", branch: "feat/a" }),
    ]);
    expect(branched?.map((group) => [group.label, hasMainCheckoutBadge(group)])).toEqual([
      ["feat/a", true],
      ["feat/a", false],
    ]);
  });

  it("keeps the same path on two environments in separate groups", () => {
    const groups = groupThreadsByWorktree([
      thread("laptop-wt", { sentAt: "2026-10-03T00:00:00.000Z", worktreePath: "/w/fix" }),
      thread("server-wt", {
        sentAt: "2026-10-02T00:00:00.000Z",
        worktreePath: "/w/fix",
        environmentId: server,
      }),
      thread("server-main", { sentAt: "2026-10-01T00:00:00.000Z", environmentId: server }),
    ]);
    expect(groups?.map((group) => group.key)).toEqual([
      "server:project-1:<main>",
      "laptop:project-1:/w/fix",
      "server:project-1:/w/fix",
    ]);
    expect(threadWorktreeGroupKey(thread("x", { sentAt: "", worktreePath: " /w/fix " }))).toBe(
      "laptop:project-1:/w/fix",
    );
  });
});

describe("sidebarGroupCollapseKey", () => {
  it("is stable per group and differs across modes and group kinds", () => {
    const project = { kind: "project", projectKey: "repo" } as const;
    const worktree = { kind: "worktree", key: "repo" } as const;
    expect(sidebarGroupCollapseKey("project", project)).toBe("project:project:repo");
    expect(sidebarGroupCollapseKey("project", worktree)).toBe("project:worktree:repo");
    expect(sidebarGroupCollapseKey("status", project)).not.toBe(
      sidebarGroupCollapseKey("project", project),
    );
  });
});

describe("buildProjectViewFolders", () => {
  const repo = { projectKey: "repo" };
  const docs = { projectKey: "docs" };
  const main = thread("main", { sentAt: "2026-10-01T00:00:00.000Z" });
  const wtA = thread("wt-a", { sentAt: "2026-10-03T00:00:00.000Z", worktreePath: "/w/a" });
  const wtA2 = thread("wt-a-2", { sentAt: "2026-10-02T00:00:00.000Z", worktreePath: "/w/a" });
  const doc = thread("doc", { sentAt: "2026-10-04T00:00:00.000Z" });
  const folders = [
    { group: repo, threads: [wtA, wtA2, main] },
    { group: docs, threads: [doc] },
  ];
  const build = (collapsed: readonly string[], openThreadKey: string | null = null) =>
    buildProjectViewFolders({
      folders,
      isCollapsed: (key) => collapsed.includes(key),
      openThreadKey,
      threadKey: (entry) => entry.id,
    });

  it("lists rows in screen order and skips the worktree layer for main-only projects", () => {
    const [repoFolder, docsFolder] = build([]);
    expect(repoFolder?.worktrees?.map((worktree) => ids(worktree.visibleThreads))).toEqual([
      ["main"],
      ["wt-a", "wt-a-2"],
    ]);
    expect(ids(repoFolder!.threads)).toEqual(["main", "wt-a", "wt-a-2"]);
    expect(docsFolder?.worktrees).toBeNull();
    expect(ids(docsFolder!.threads)).toEqual(["doc"]);
  });

  it("keeps only the open thread visible in a folded worktree or folder", () => {
    const worktreeKey = sidebarGroupCollapseKey("project", {
      kind: "worktree",
      key: threadWorktreeGroupKey(wtA),
    });
    const [repoFolder] = build([worktreeKey], "wt-a-2");
    const linked = repoFolder?.worktrees?.[1];
    expect(linked?.collapsed).toBe(true);
    expect(ids(linked!.visibleThreads)).toEqual(["wt-a-2"]);
    expect(ids(linked!.hiddenThreads)).toEqual(["wt-a"]);
    expect(ids(repoFolder!.threads)).toEqual(["main", "wt-a-2"]);

    const [foldedRepo] = build(["project:project:repo"], "main");
    expect(foldedRepo?.worktrees).toBeNull();
    expect(ids(foldedRepo!.threads)).toEqual(["main"]);
    expect(ids(foldedRepo!.hiddenThreads)).toEqual(["wt-a", "wt-a-2"]);
  });

  it("flattens folders into header and thread rows, counting threads a fold hides", () => {
    const shape = (rows: ReadonlyArray<ProjectViewRow<unknown, typeof main>>) =>
      rows.map((row) =>
        row.kind === "thread"
          ? row.thread.id
          : `${row.kind}:${row.collapseKey}:${row.count}${row.collapsed ? ":folded" : ""}`,
      );
    expect(shape(flattenProjectViewFolders(build([])))).toEqual([
      "project:project:project:repo:3",
      `worktree:project:worktree:${threadWorktreeGroupKey(main)}:1`,
      "main",
      `worktree:project:worktree:${threadWorktreeGroupKey(wtA)}:2`,
      "wt-a",
      "wt-a-2",
      "project:project:project:docs:1",
      "doc",
    ]);
    // A folded project drops its worktree headers but still counts every thread, and keeps the open one.
    const folded = build(["project:project:repo"], "wt-a");
    expect(projectViewFolderThreadCount(folded[0]!)).toBe(3);
    expect(shape(flattenProjectViewFolders(folded)).slice(0, 2)).toEqual([
      "project:project:project:repo:3:folded",
      "wt-a",
    ]);
  });

  it("ignores another view's folds", () => {
    const [repoFolder] = build(["status:project:repo"]);
    expect(repoFolder?.collapsed).toBe(false);
  });
});

describe("groupThreadsByProject", () => {
  it("puts each thread in its project's folder and drops empty projects unless kept", () => {
    const remote = EnvironmentId.make("environment-remote");
    const t3code = ProjectId.make("t3code");
    const t3codeRemote = ProjectId.make("t3code-remote");
    const fleet = ProjectId.make("fleet");
    const entry = (id: string, environmentId: EnvironmentId, project: ProjectId) => ({
      id,
      environmentId,
      projectId: project,
    });
    const groups = [
      {
        projectKey: "t3code",
        memberProjectRefs: [
          { environmentId: laptop, projectId: t3code },
          { environmentId: remote, projectId: t3codeRemote },
        ],
      },
      { projectKey: "fleet", memberProjectRefs: [{ environmentId: laptop, projectId: fleet }] },
      {
        projectKey: "notes",
        memberProjectRefs: [{ environmentId: laptop, projectId: ProjectId.make("notes") }],
      },
    ];
    const threads = [
      entry("a", laptop, t3code),
      entry("orphan", laptop, ProjectId.make("deleted")),
      entry("b", remote, t3codeRemote),
    ];
    const summarize = (keepEmpty: (group: (typeof groups)[number]) => boolean) =>
      groupThreadsByProject(groups, threads, keepEmpty).map((folder) => [
        folder.group.projectKey,
        ids(folder.threads),
      ]);

    expect(summarize(() => true)).toEqual([
      ["t3code", ["a", "b"]],
      ["fleet", []],
      ["notes", []],
    ]);
    expect(summarize(() => false)).toEqual([["t3code", ["a", "b"]]]);
    expect(summarize((group) => group.projectKey === "fleet")).toEqual([
      ["t3code", ["a", "b"]],
      ["fleet", []],
    ]);
  });
});

const completedRun = {
  runId: "turn-1" as never,
  status: "completed" as const,
  assistantMessageId: null,
  requestedAt: "2026-03-09T10:00:00.000Z",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
};

describe("resolveSidebarThreadStatus", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

  it("prioritizes awaiting input over a running runtime, below approval", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingUserInput: true,
        runtime,
        blockedOnThreadWait: true,
      }),
    ).toBe("input");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        blockedOnThreadWait: true,
        runtime,
      }),
    ).toBe("approval");
  });

  it("shows a waiting guest message as a Request, below the agent's own requests", () => {
    expect(resolveSidebarThreadStatus({ ...idle, pendingGuestMessageCount: 1, runtime })).toBe(
      "request",
    );
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingUserInput: true,
        pendingGuestMessageCount: 1,
      }),
    ).toBe("input");
  });

  it("keeps usage-limit stops Limited and visible until the thread recovers", () => {
    const limited = {
      ...runtime,
      status: "failed" as const,
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit" as const,
    };
    expect(resolveSidebarThreadStatus({ ...idle, runtime: limited })).toBe("limited");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "running" } }),
    ).toBe("working");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "completed" } }),
    ).toBe("ready");
  });

  it("reports worktree setup as preparing, and failed only while the latest run failed", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "preparing" as const },
      }),
    ).toBe("preparing");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "completed" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "idle" as const, lastError: "persisted" },
      }),
    ).toBe("waiting");
  });
});

describe("resolveSidebarFolderDot", () => {
  it("flags the most urgent hidden thread and stays quiet otherwise", () => {
    const idle = {
      hasActionableProposedPlan: false,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      interactionMode: "default" as const,
      latestRun: completedRun,
      lastVisitedAt: "2026-03-09T10:06:00.000Z",
      runtime: null,
    };
    const runtime = {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    };
    const working = { ...idle, runtime };
    const unread = { ...idle, lastVisitedAt: "2026-03-09T10:04:00.000Z" };
    const limited = {
      ...idle,
      runtime: { ...runtime, status: "failed" as const, lastErrorClass: "usage_limit" as const },
    };

    expect(resolveSidebarFolderDot([idle])).toBeNull();
    // A waiting thread stays quiet even with an unread completion, like its row.
    expect(
      resolveSidebarFolderDot([{ ...unread, runtime: { ...runtime, status: "idle" as const } }]),
    ).toBeNull();
    expect(resolveSidebarFolderDot([idle, working])).toBe("working");
    expect(resolveSidebarFolderDot([working, unread])).toBe("unread");
    expect(resolveSidebarFolderDot([unread, limited])).toBe("attention");
  });
});
