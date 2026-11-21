// fork: which listeners the preview tunnel never reaches, one pure function over a process table
// read a moment ago: this server and what started it (E1), its other children that are no terminal
// and no provider (E2), a provider's own process and runtimes (E3, E4), and debug processes (E7).
// Anything else is forwarded, whoever started it.
import type { ProcessRow, ProcessTable } from "./ProcessInspector.ts";
import {
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
