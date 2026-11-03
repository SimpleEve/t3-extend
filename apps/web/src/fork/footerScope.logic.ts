import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";

export type FooterScopeSource = "scope" | "route" | "primary" | "none";

export interface FooterScope {
  readonly environmentId: EnvironmentId | null;
  /** Projects the chips are about; empty means every project of the environment. */
  readonly projectRefs: readonly ScopedProjectRef[];
  readonly source: FooterScopeSource;
}

/**
 * The environment the footer chips describe: the sidebar's chosen project first, then the open
 * thread's project, then the environment this client runs in. A project choice that spans
 * environments has no single machine, so it falls through to the open thread.
 */
export function resolveFooterScope(input: {
  readonly scopedProjectRefs: readonly ScopedProjectRef[];
  readonly routeProjectRef: ScopedProjectRef | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): FooterScope {
  const [first] = input.scopedProjectRefs;
  if (first && input.scopedProjectRefs.every((ref) => ref.environmentId === first.environmentId)) {
    return {
      environmentId: first.environmentId,
      projectRefs: input.scopedProjectRefs,
      source: "scope",
    };
  }
  if (input.routeProjectRef) {
    return {
      environmentId: input.routeProjectRef.environmentId,
      projectRefs: [input.routeProjectRef],
      source: "route",
    };
  }
  if (input.primaryEnvironmentId) {
    return { environmentId: input.primaryEnvironmentId, projectRefs: [], source: "primary" };
  }
  return { environmentId: null, projectRefs: [], source: "none" };
}

export function sameScopedProjectRefs(
  left: readonly ScopedProjectRef[],
  right: readonly ScopedProjectRef[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ref, index) =>
        ref.environmentId === right[index]?.environmentId &&
        ref.projectId === right[index]?.projectId,
    )
  );
}
