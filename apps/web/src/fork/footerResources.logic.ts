import type { ResourceTelemetryProcess, ResourceTelemetrySnapshot } from "@t3tools/contracts";

import { formatBytes } from "../lib/formatBytes";

export type FooterResourceRowKind = "agent" | "terminal" | "t3" | "other";

export interface FooterResourceRow {
  /** Stable key: `agent:<provider>`, `terminal`, `t3`, or `other`. */
  readonly id: string;
  readonly kind: FooterResourceRowKind;
  /** The provider's name for an agent row; the other rows are named where they are shown. */
  readonly label: string | null;
  readonly processCount: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
}

export interface FooterResourceSummary {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly rows: readonly FooterResourceRow[];
}

// fork: mirrors the rules of apps/server/src/resourceTelemetry/ProcessGroupMetrics.ts. The server
// never sets the `provider-root` or `terminal-root` category, so a process belongs to the direct
// child of the server that it descends from, and that child is named by its own name.
const PROVIDERS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/codex/, "codex", "Codex"],
  [/claude/, "claude", "Claude"],
  [/cursor/, "cursor", "Cursor"],
  [/opencode/, "opencode", "OpenCode"],
  [/grok/, "grok", "Grok"],
  [/antigravity|gemini/, "antigravity", "Antigravity"],
];
const TERMINAL_SHELL = /^(?:ba|z|fi|da|c)?sh(?:\.exe)?$|^pwsh|^powershell|^cmd\.exe$/;
// A CLI shipped as a script runs under a JavaScript runtime, so only these are matched by command
// line; any other name is matched by name alone, so a shell whose arguments mention a provider
// stays a terminal.
const SCRIPT_RUNTIME = /^(?:node|bun|deno)(?:\.exe)?$/;

type RowOwner =
  | { readonly kind: "agent"; readonly provider: string; readonly label: string }
  | { readonly kind: "terminal" | "t3" | "other" };

const TERMINAL: RowOwner = { kind: "terminal" };
const T3: RowOwner = { kind: "t3" };
const OTHER: RowOwner = { kind: "other" };

function matchProvider(text: string): RowOwner | undefined {
  const found = PROVIDERS.find(([pattern]) => pattern.test(text));
  return found && { kind: "agent", provider: found[1], label: found[2] };
}

function ownerOfServerChild(process: ResourceTelemetryProcess): RowOwner {
  const name = process.name.toLowerCase();
  if (SCRIPT_RUNTIME.test(name)) return matchProvider(process.command.toLowerCase()) ?? OTHER;
  return matchProvider(name) ?? (TERMINAL_SHELL.test(name) ? TERMINAL : OTHER);
}

function ownerOf(
  process: ResourceTelemetryProcess,
  byPid: ReadonlyMap<number, ResourceTelemetryProcess>,
  serverPid: number | undefined,
  limit: number,
): RowOwner {
  if (
    process.category === "server" ||
    process.category === "resource-monitor" ||
    process.category.startsWith("electron-")
  ) {
    return T3;
  }
  let current = process;
  // Bounded by the table size, in case a reused PID makes the parent chain loop.
  for (let step = 0; step < limit; step++) {
    if (current.ppid === serverPid) return ownerOfServerChild(current);
    const parent = byPid.get(current.ppid);
    if (parent === undefined) break;
    current = parent;
  }
  return OTHER;
}

const KIND_ORDER: Record<FooterResourceRowKind, number> = {
  agent: 0,
  terminal: 1,
  t3: 2,
  other: 3,
};

/**
 * Totals of every T3 process, and the same processes split into one row per agent provider, the
 * terminals, T3 itself, and the rest. Each process is counted in exactly one row. Null until the
 * first sample has listed any process.
 */
export function summarizeResources(
  snapshot: ResourceTelemetrySnapshot,
): FooterResourceSummary | null {
  const { allT3 } = snapshot.groups;
  if (allT3.processCount === 0 && snapshot.processes.length === 0) return null;

  const byPid = new Map(snapshot.processes.map((process) => [process.identity.pid, process]));
  const serverPid = snapshot.processes.find((process) => process.category === "server")?.identity
    .pid;
  const rows = new Map<string, FooterResourceRow>();
  for (const process of snapshot.processes) {
    const owner = ownerOf(process, byPid, serverPid, snapshot.processes.length);
    const id = owner.kind === "agent" ? `agent:${owner.provider}` : owner.kind;
    const row = rows.get(id) ?? {
      id,
      kind: owner.kind,
      label: owner.kind === "agent" ? owner.label : null,
      processCount: 0,
      cpuPercent: 0,
      rssBytes: 0,
    };
    rows.set(id, {
      ...row,
      processCount: row.processCount + 1,
      cpuPercent: row.cpuPercent + process.cpuPercent,
      rssBytes: row.rssBytes + process.residentBytes,
    });
  }
  return {
    cpuPercent: allT3.currentCpuPercent,
    rssBytes: allT3.currentRssBytes,
    rows: [...rows.values()].toSorted(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.rssBytes - a.rssBytes,
    ),
  };
}

/** CPU is summed over cores, so 100 is one full core and the share can pass 100. */
export function formatCpuPercent(value: number): string {
  return `${Math.round(Number.isFinite(value) ? Math.max(0, value) : 0)}%`;
}

export function footerResourcesLabels(
  summary: Pick<FooterResourceSummary, "cpuPercent" | "rssBytes">,
): {
  readonly full: string;
  readonly compact: string;
} {
  const memory = formatBytes(summary.rssBytes);
  return { full: `${formatCpuPercent(summary.cpuPercent)} · ${memory}`, compact: memory };
}
