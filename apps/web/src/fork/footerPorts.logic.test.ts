import type { DiscoveredLocalServer, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { footerPortsLabels, selectProjectServers } from "./footerPorts.logic";

const env = "env-a" as EnvironmentId;
const project = (id: string) => id as ProjectId;
const thread = (
  id: string,
  projectId: string,
  worktreePath: string | null = null,
  environmentId = env,
) => ({
  environmentId,
  id: id as ThreadId,
  projectId: project(projectId),
  title: id,
  worktreePath,
});
const server = (
  port: number,
  owner: { terminal?: string; agent?: string } = {},
  processName: string | null = "node",
) =>
  ({
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}/`,
    processName,
    pid: port,
    terminal: owner.terminal ? { threadId: owner.terminal as ThreadId, terminalId: "t" } : null,
    ...(owner.agent ? { agent: { threadId: owner.agent as ThreadId } } : {}),
  }) as unknown as DiscoveredLocalServer;

describe("footer ports", () => {
  const threads = [
    thread("main", "p1"),
    thread("wt", "p1", "/Users/me/.t3/worktrees/repo/feature-x"),
    thread("other-project", "p2"),
    thread("other-env", "p1", null, "env-b" as EnvironmentId),
  ];
  const servers = [
    server(8765, { terminal: "wt" }, "python3"),
    server(3000, { agent: "main" }),
    server(5173, { terminal: "other-project" }),
    server(9000, { terminal: "other-env" }),
    server(9100), // no owner
    server(9200, { agent: "gone" }),
  ];

  it("lists only servers whose thread is in the shown project, with its worktree", () => {
    const rows = selectProjectServers({
      servers,
      threads,
      environmentId: env,
      projectRefs: [{ environmentId: env, projectId: project("p1") }],
    });
    expect(rows.map((row) => [row.port, row.threadTitle, row.worktree, row.processName])).toEqual([
      [3000, "main", null, "node"],
      [8765, "wt", "feature-x", "python3"],
    ]);
    expect(rows[1]?.threadRef).toEqual({ environmentId: env, threadId: "wt" });
  });

  it("covers every project of the environment when none is chosen, and drops duplicate ports", () => {
    const rows = selectProjectServers({
      servers: [...servers, server(3000, { terminal: "wt" })],
      threads,
      environmentId: env,
      projectRefs: [],
    });
    expect(rows.map((row) => [row.port, row.threadTitle])).toEqual([
      [3000, "main"],
      [5173, "other-project"],
      [8765, "wt"],
    ]);
  });

  it("labels up to three ports and counts the rest", () => {
    const ports = [3000, 4000, 5000, 6000, 7000].map((port) => ({ port }));
    expect(footerPortsLabels(ports)).toEqual({ full: ":3000 :4000 :5000 +2", compact: "5" });
    expect(footerPortsLabels(ports.slice(0, 2))).toEqual({ full: ":3000 :4000", compact: "2" });
  });
});
