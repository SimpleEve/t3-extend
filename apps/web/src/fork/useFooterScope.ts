import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  useConnectedEnvironmentIds,
  useEnvironmentConnectionSummaries,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useQuietThreadShell } from "../state/entities";
import { resolveActiveThreadRouteRef } from "../threadRoutes";
import { type FooterScope, resolveFooterScope } from "./footerScope.logic";

export interface FooterScopeView extends FooterScope {
  /** Names the machine only when more than one environment is connected. */
  readonly machineLabel: string | null;
}

export function useFooterScope(scopedProjectRefs: readonly ScopedProjectRef[]): FooterScopeView {
  const routeTarget = useThreadRouteTarget();
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, draft);
  const routeShell = useQuietThreadShell(routeThreadRef);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const summaries = useEnvironmentConnectionSummaries();

  const routeProjectRef: ScopedProjectRef | null = routeShell
    ? scopeProjectRef(routeShell.environmentId, routeShell.projectId)
    : draft
      ? scopeProjectRef(draft.environmentId, draft.projectId)
      : null;

  const scope = resolveFooterScope({ scopedProjectRefs, routeProjectRef, primaryEnvironmentId });
  const machineLabel =
    connectedIds.length > 1 && scope.environmentId !== null
      ? (summaries.find((summary) => summary.environmentId === scope.environmentId)
          ?.environmentLabel ?? null)
      : null;
  return { ...scope, machineLabel };
}
