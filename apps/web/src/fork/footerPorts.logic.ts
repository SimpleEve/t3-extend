import type {
  DiscoveredLocalServer,
  EnvironmentId,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export interface FooterPortRow {
  readonly port: number;
  readonly server: DiscoveredLocalServer;
  readonly processName: string | null;
  readonly threadRef: ScopedThreadRef;
  /** The thread's own title; a placeholder title is translated where it is shown. */
  readonly threadTitle: string;
  /** The worktree's folder name, or null for the project's main checkout. */
  readonly worktree: string | null;
}

type ThreadForPorts = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId" | "title" | "worktreePath"
>;

const folderName = (path: string): string =>
  path.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? path;

/**
 * The listening servers that a thread of the shown projects started, through its agent or one of
 * its terminals. A server no thread owns, or whose thread belongs to another project or
 * environment, is left out. No project refs means every project of the environment.
 */
export function selectProjectServers(input: {
  readonly servers: readonly DiscoveredLocalServer[];
  readonly threads: readonly ThreadForPorts[];
  readonly environmentId: EnvironmentId;
  readonly projectRefs: readonly ScopedProjectRef[];
}): readonly FooterPortRow[] {
  const projectIds = new Set(
    input.projectRefs
      .filter((ref) => ref.environmentId === input.environmentId)
      .map((ref) => ref.projectId),
  );
  const threadsById = new Map(
    input.threads
      .filter(
        (thread) =>
          thread.environmentId === input.environmentId &&
          (input.projectRefs.length === 0 || projectIds.has(thread.projectId)),
      )
      .map((thread) => [thread.id, thread]),
  );
  const rows = new Map<number, FooterPortRow>();
  for (const server of input.servers) {
    const threadId = server.terminal?.threadId ?? server.agent?.threadId;
    const thread = threadId === undefined ? undefined : threadsById.get(threadId);
    if (thread === undefined || rows.has(server.port)) continue;
    rows.set(server.port, {
      port: server.port,
      server,
      processName: server.processName,
      threadRef: { environmentId: thread.environmentId, threadId: thread.id },
      threadTitle: thread.title,
      worktree: thread.worktreePath === null ? null : folderName(thread.worktreePath),
    });
  }
  return [...rows.values()].toSorted((a, b) => a.port - b.port);
}

const MAX_LABELLED_PORTS = 3;

/** ":3000 :8765 +2" while there is room, and the bare count when there is not. */
export function footerPortsLabels(rows: readonly Pick<FooterPortRow, "port">[]): {
  readonly full: string;
  readonly compact: string;
} {
  const shown = rows.slice(0, MAX_LABELLED_PORTS).map((row) => `:${row.port}`);
  const extra = rows.length - shown.length;
  return {
    full: extra > 0 ? `${shown.join(" ")} +${extra}` : shown.join(" "),
    compact: String(rows.length),
  };
}
