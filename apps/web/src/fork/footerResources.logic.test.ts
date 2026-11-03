import type {
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  footerResourcesLabels,
  formatCpuPercent,
  summarizeResources,
} from "./footerResources.logic";

const SERVER = 100;

function proc(
  pid: number,
  ppid: number,
  name: string,
  rss: number,
  extra: { command?: string; category?: ResourceTelemetryProcessCategory; cpu?: number } = {},
) {
  return {
    identity: { pid, startTimeMs: 0 },
    ppid,
    name,
    command: extra.command ?? name,
    category: extra.category ?? "server-child",
    cpuPercent: extra.cpu ?? 1,
    residentBytes: rss,
  } as unknown as ResourceTelemetryProcess;
}

function snapshot(processes: ResourceTelemetryProcess[], total = { cpu: 0, rss: 0 }) {
  return {
    groups: {
      allT3: {
        processCount: processes.length,
        currentCpuPercent: total.cpu,
        currentRssBytes: total.rss,
      },
    },
    processes,
  } as unknown as ResourceTelemetrySnapshot;
}

describe("footer resources", () => {
  it("puts each process in one row by the server child it descends from", () => {
    const processes = [
      proc(SERVER, 1, "node", 100, { category: "server" }),
      proc(101, 1, "t3-resource-monitor", 10, { category: "resource-monitor" }),
      proc(102, 1, "Electron", 50, { category: "electron-main" }),
      // An agent and everything it starts, however deep.
      proc(110, SERVER, "codex", 300),
      proc(111, 110, "zsh", 20),
      proc(112, 111, "node", 200, { command: "node vite dev" }),
      // An agent shipped as a script under a JavaScript runtime is named by its command line.
      proc(120, SERVER, "node", 400, { command: "node /x/@anthropic-ai/claude-code/cli.js" }),
      proc(121, 120, "bash", 30),
      // A shell whose arguments mention a provider is still a terminal.
      proc(130, SERVER, "zsh", 15, { command: "zsh -c codex" }),
      proc(131, 130, "node", 60),
      proc(140, SERVER, "git", 5),
    ];
    const summary = summarizeResources(snapshot(processes, { cpu: 12, rss: 1_190 }));

    expect(summary?.rows.map((row) => [row.id, row.label, row.processCount, row.rssBytes])).toEqual(
      [
        // Agents come first, the biggest by memory on top.
        ["agent:codex", "Codex", 3, 520],
        ["agent:claude", "Claude", 2, 430],
        ["terminal", null, 2, 75],
        ["t3", null, 3, 160],
        ["other", null, 1, 5],
      ],
    );
    // The rows are a partition of the table.
    expect(summary?.rows.reduce((sum, row) => sum + row.processCount, 0)).toBe(processes.length);
    expect(summary).toMatchObject({ cpuPercent: 12, rssBytes: 1_190 });
  });

  it("files orphans and parent loops under other without looping forever", () => {
    const summary = summarizeResources(
      snapshot([
        proc(SERVER, 1, "node", 100, { category: "server" }),
        proc(200, 999, "node", 10),
        proc(210, 211, "node", 20),
        proc(211, 210, "node", 30),
      ]),
    );
    expect(summary?.rows.map((row) => [row.id, row.processCount, row.rssBytes])).toEqual([
      ["t3", 1, 100],
      ["other", 3, 60],
    ]);
  });

  it("has nothing to show before the first sample, then prints CPU and memory", () => {
    expect(summarizeResources(snapshot([]))).toBeNull();
    const summary = { cpuPercent: 12.6, rssBytes: 1_288_490_189 };
    expect(footerResourcesLabels(summary)).toEqual({ full: "13% · 1.20 GB", compact: "1.20 GB" });
    expect(formatCpuPercent(Number.NaN)).toBe("0%");
    expect(formatCpuPercent(-3)).toBe("0%");
  });
});
