// fork: the gateway's ownership and exclusion rules E1 to E7 (design 5.6.3), one pure function
// over a process table read a moment ago; nothing is cached or registered.
import type { ProcessRow, ProcessTable } from "./ProcessInspector.ts";
import {
  hasAgentMarker,
  hasDebugFlag,
  matchRoot,
  matchesRuntime,
  type ExtraExecutable,
  type ResolvePath,
} from "./RuntimeSignatures.ts";

export interface ShellEntry {
  /** Start time read when the terminal manager reported the shell; `null` if it could not be read. */
  readonly startTime: string | null;
}

export type ExclusionRule = "E1" | "E2" | "E3" | "E4" | "E5" | "E7" | "none";

export type ClassifyVerdict =
  | { readonly allow: true; readonly owner: "terminal" | "agent" }
  | {
      readonly allow: false;
      readonly code: "reserved" | "not-owned" | "debug-process";
      readonly rule: ExclusionRule;
      /** A fixed phrase for logs; never process arguments or environment. */
      readonly reason: string;
    };

const deny = (
  code: "reserved" | "not-owned" | "debug-process",
  rule: ExclusionRule,
  reason: string,
): ClassifyVerdict => ({ allow: false, code, rule, reason });

const MAX_DEPTH = 64;

/** `pid` first, then its parent, up to the table's edge. Stops on a cycle. */
const ancestry = (table: ProcessTable, pid: number): ReadonlyArray<ProcessRow> => {
  const chain: Array<ProcessRow> = [];
  const seen = new Set<number>();
  let current = table.get(pid);
  while (current !== undefined && !seen.has(current.pid) && chain.length < MAX_DEPTH) {
    chain.push(current);
    seen.add(current.pid);
    current = table.get(current.ppid);
  }
  return chain;
};

export interface ClassifyInput {
  readonly serverPid: number;
  readonly table: ProcessTable;
  readonly listenerPid: number;
  /** The listener's argv and launch environment, read for this check. */
  readonly launchText: string;
  /** The terminal shells that are running now. */
  readonly shells: ReadonlyMap<number, ShellEntry>;
  readonly extraExecutables?: ReadonlyArray<ExtraExecutable>;
  /** Real paths for configured binaries; the identity when absent. */
  readonly resolvePath?: ResolvePath;
}

export const classifyListener = (input: ClassifyInput): ClassifyVerdict => {
  const { table, serverPid, listenerPid } = input;
  const extra = input.extraExecutables ?? [];
  const resolve = input.resolvePath ?? ((path: string) => path);
  const chain = ancestry(table, listenerPid);
  const listener = chain[0];
  if (listener === undefined || listener.pid !== listenerPid) {
    return deny("not-owned", "none", "the listener is not in the process table");
  }

  if (listenerPid === serverPid) return deny("reserved", "E1", "the listener is this server");
  if (ancestry(table, serverPid).some((row) => row.pid === listenerPid)) {
    return deny("reserved", "E1", "the listener is an ancestor of this server");
  }

  if (hasDebugFlag(input.launchText) || hasDebugFlag(listener.args)) {
    return deny("debug-process", "E7", "the process was started with debug flags");
  }

  if (matchesRuntime(listener.args, extra, resolve)) {
    return deny("reserved", "E4", "the process looks like a provider runtime");
  }

  const serverIndex = chain.findIndex((row) => row.pid === serverPid);
  if (serverIndex < 0) {
    // No longer anyone's child of this server (or never): a leftover runtime's tree is excluded
    // outright, and anything else cannot show that this server's agent or terminal started it.
    return chain.some((row) => matchesRuntime(row.args, extra, resolve))
      ? deny("reserved", "E4", "the process runs under a leftover provider runtime")
      : deny("not-owned", "E5", "the process is not a descendant of this server");
  }

  const root = chain[serverIndex - 1]!;
  const shell = input.shells.get(root.pid);
  if (shell !== undefined && shell.startTime !== null && shell.startTime === root.startTime) {
    return { allow: true, owner: "terminal" };
  }

  const driver = matchRoot(root.args, extra, resolve);
  if (driver === null) {
    return deny(
      "reserved",
      "E2",
      "a direct child of this server that is not a terminal or a provider",
    );
  }
  if (root.pid === listenerPid) {
    return deny("reserved", "E3", "the provider's own process");
  }
  if (driver.agentJobs && hasAgentMarker(input.launchText)) {
    return { allow: true, owner: "agent" };
  }
  return deny("not-owned", "E5", "not started by a terminal or by an agent of this server");
};
