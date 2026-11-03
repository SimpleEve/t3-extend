import type { ResourceTelemetryProcess, ResourceTelemetrySnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  footerResourcesLabels,
  formatCpuPercent,
  summarizeResources,
} from "./footerResources.logic";

const aggregate = (processCount: number, cpu: number, rss: number) => ({
  processCount,
  currentCpuPercent: cpu,
  currentRssBytes: rss,
});
const proc = (pid: number, residentBytes: number) =>
  ({ identity: { pid, startTimeMs: 0 }, residentBytes }) as unknown as ResourceTelemetryProcess;

const snapshot = (
  groups: Record<"backend" | "electron" | "monitor" | "allT3", ReturnType<typeof aggregate>>,
  processes: ResourceTelemetryProcess[] = [],
) => ({ groups, processes }) as unknown as ResourceTelemetrySnapshot;

describe("footer resources", () => {
  it("totals everything and leaves out groups with no processes", () => {
    const summary = summarizeResources(
      snapshot({
        backend: aggregate(3, 12.4, 300_000_000),
        electron: aggregate(0, 0, 0),
        monitor: aggregate(1, 0.5, 10_000_000),
        allT3: aggregate(4, 12.9, 310_000_000),
      }),
    );
    expect(summary.cpuPercent).toBe(12.9);
    expect(summary.rssBytes).toBe(310_000_000);
    expect(summary.groups.map((group) => group.key)).toEqual(["backend", "monitor"]);
  });

  it("lists the five biggest processes by memory without reordering the input", () => {
    const processes = [1, 2, 3, 4, 5, 6, 7].map((pid) => proc(pid, pid * 100));
    const summary = summarizeResources(
      snapshot(
        {
          backend: aggregate(7, 0, 0),
          electron: aggregate(0, 0, 0),
          monitor: aggregate(0, 0, 0),
          allT3: aggregate(7, 0, 0),
        },
        processes,
      ),
    );
    expect(summary.topProcesses.map((process) => process.identity.pid)).toEqual([7, 6, 5, 4, 3]);
    expect(processes[0]?.identity.pid).toBe(1);
  });

  it("prints CPU and memory in full and only memory when compact", () => {
    const summary = { cpuPercent: 12.6, rssBytes: 1_288_490_189, groups: [], topProcesses: [] };
    expect(footerResourcesLabels(summary)).toEqual({ full: "13% · 1.20 GB", compact: "1.20 GB" });
    expect(formatCpuPercent(Number.NaN)).toBe("0%");
    expect(formatCpuPercent(-3)).toBe("0%");
  });
});
