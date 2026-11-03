import type { ResourceTelemetryProcess, ResourceTelemetrySnapshot } from "@t3tools/contracts";

import { formatBytes } from "../lib/formatBytes";

const TOP_PROCESS_COUNT = 5;

export type FooterResourceGroupKey = "backend" | "electron" | "monitor";

export interface FooterResourceGroup {
  readonly key: FooterResourceGroupKey;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
}

export interface FooterResourceSummary {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly groups: readonly FooterResourceGroup[];
  readonly topProcesses: readonly ResourceTelemetryProcess[];
}

/** Totals of every T3 process on the machine, the per-group split, and the biggest by memory. */
export function summarizeResources(snapshot: ResourceTelemetrySnapshot): FooterResourceSummary {
  const { groups } = snapshot;
  const split: FooterResourceGroup[] = [];
  for (const key of ["backend", "electron", "monitor"] as const) {
    const aggregate = groups[key];
    // An environment with no desktop app, or no sidecar yet, has nothing to list for that group.
    if (aggregate.processCount === 0) continue;
    split.push({
      key,
      cpuPercent: aggregate.currentCpuPercent,
      rssBytes: aggregate.currentRssBytes,
      processCount: aggregate.processCount,
    });
  }
  return {
    cpuPercent: groups.allT3.currentCpuPercent,
    rssBytes: groups.allT3.currentRssBytes,
    groups: split,
    topProcesses: snapshot.processes
      .toSorted((a, b) => b.residentBytes - a.residentBytes)
      .slice(0, TOP_PROCESS_COUNT),
  };
}

/** CPU is summed over cores, so 100 is one full core and the share can pass 100. */
export function formatCpuPercent(value: number): string {
  return `${Math.round(Number.isFinite(value) ? Math.max(0, value) : 0)}%`;
}

export function footerResourcesLabels(summary: FooterResourceSummary): {
  readonly full: string;
  readonly compact: string;
} {
  const memory = formatBytes(summary.rssBytes);
  return { full: `${formatCpuPercent(summary.cpuPercent)} · ${memory}`, compact: memory };
}
