// fork: which listeners the preview tunnel never reaches, one pure function over a process table
// read a moment ago: this server and what started it (E1), its other children that are no terminal
// and no provider (E2), a provider's own process and runtimes (E3, E4), and debug processes (E7).
// Anything else is forwarded, whoever started it.
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

export type ExclusionRule = "E1" | "E2" | "E3" | "E4" | "E7";

export type ClassifyVerdict =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly code: "reserved" | "debug-process";
      readonly rule: ExclusionRule;
      /** A fixed phrase for logs; never process arguments or environment. */
      readonly reason: string;
    };

const ALLOW: ClassifyVerdict = { allow: true };

const deny = (
  code: "reserved" | "debug-process",
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
  /**
   * The launch text of the server's direct child above the listener (`serverChildOf`), when the
   * listener is not that child itself. A provider without a known process shape is told from T3's
   * own helpers by the thread marker its adapter puts in the agent's environment.
   */
  readonly rootLaunchText?: string | null;
  readonly extraExecutables?: ReadonlyArray<ExtraExecutable>;
  /** Real paths for configured binaries; the identity when absent. */
  readonly resolvePath?: ResolvePath;
}

/** The server's direct child that `pid` runs under (or is), or `null` when it is not under the server. */
export const serverChildOf = (
  table: ProcessTable,
  serverPid: number,
  pid: number,
): number | null => {
  const chain = ancestry(table, pid);
  const index = chain.findIndex((row) => row.pid === serverPid);
  return index > 0 ? chain[index - 1]!.pid : null;
};

export const classifyListener = (input: ClassifyInput): ClassifyVerdict => {
  const { table, serverPid, listenerPid } = input;
  const extra = input.extraExecutables ?? [];
  const resolve = input.resolvePath ?? ((path: string) => path);
  const chain = ancestry(table, listenerPid);
  const listener = chain[0];
  const debugged = deny("debug-process", "E7", "the process was started with debug flags");
  // Gone from the table since the listeners were read: only its launch text is left to check.
  if (listener === undefined || listener.pid !== listenerPid) {
    return hasDebugFlag(input.launchText) ? debugged : ALLOW;
  }

  if (listenerPid === serverPid) return deny("reserved", "E1", "the listener is this server");
  if (ancestry(table, serverPid).some((row) => row.pid === listenerPid)) {
    return deny("reserved", "E1", "the listener is an ancestor of this server");
  }

  if (hasDebugFlag(input.launchText) || hasDebugFlag(listener.args)) return debugged;

  if (matchesRuntime(listener.args, extra, resolve)) {
    return deny("reserved", "E4", "the process looks like a provider runtime");
  }

  const serverIndex = chain.findIndex((row) => row.pid === serverPid);
  if (serverIndex < 0) {
    // Not under this server, such as a `nohup` service: only a leftover runtime's tree is excluded.
    return chain.some((row) => matchesRuntime(row.args, extra, resolve))
      ? deny("reserved", "E4", "the process runs under a leftover provider runtime")
      : ALLOW;
  }

  const root = chain[serverIndex - 1]!;
  const shell = input.shells.get(root.pid);
  if (shell !== undefined && shell.startTime !== null && shell.startTime === root.startTime) {
    return ALLOW;
  }

  const driver = matchRoot(root.args, extra, resolve);
  // An agent of a provider whose processes have no known shape (omp, Antigravity, the ACP
  // registry): only the provider process itself is kept out, not what it starts.
  const rootText = root.pid === listenerPid ? input.launchText : input.rootLaunchText;
  if (driver === null && rootText != null && hasAgentMarker(rootText)) {
    return root.pid === listenerPid ? deny("reserved", "E3", "the provider's own process") : ALLOW;
  }
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
  // A provider's jobs, whether or not they carry an agent marker.
  return ALLOW;
};
