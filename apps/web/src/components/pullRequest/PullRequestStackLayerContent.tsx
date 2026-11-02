import type { PullRequestStack } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { resolvePullRequestState } from "./pullRequestPresentation";
import { useT } from "~/hooks/useT"; // fork: interface language

export function PullRequestStackLayerContent({
  layer,
  compact = false,
}: {
  layer: PullRequestStack["layers"][number];
  compact?: boolean;
}) {
  const t = useT(); // fork: interface language
  const state = resolvePullRequestState({
    state: layer.state,
    isDraft: layer.isDraft ?? false,
  });
  return (
    <>
      <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{layer.title || layer.headBranch}</span>
        <span className="block truncate text-xs font-normal text-muted-foreground">
          #{layer.number} · {compact ? null : `${layer.headBranch} · `}
          {t(state.label, undefined, "pull request state")}
        </span>
      </span>
    </>
  );
}
