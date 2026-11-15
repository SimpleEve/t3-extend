import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import type { Translator } from "@t3tools/client-runtime/i18n"; // fork: i18n
import { changeRequestTerm } from "../../lib/changeRequestTerm"; // fork: i18n

type ActionDetail = Pick<
  PullRequestDetail,
  "state" | "isDraft" | "mergeability" | "autoMergeEnabled" | "workflowApprovalsRequired"
> & {
  readonly capabilities: Pick<
    PullRequestDetail["capabilities"],
    "actions" | "mergeMethods" | "updateMethods" | "deleteBranch"
  >;
  readonly viewerPermissions: Pick<
    PullRequestDetail["viewerPermissions"],
    "actions" | "updateMethods"
  >;
  readonly mergeCapabilities: PullRequestDetail["mergeCapabilities"];
};

export const MERGE_METHODS = {
  squash: { title: "Squash and merge", description: "Combine the commits into one commit." },
  merge: {
    title: "Create a merge commit",
    description: "Keep the commits and add a merge commit.",
  },
  rebase: { title: "Rebase and merge", description: "Add the commits without a merge commit." },
  "fast-forward": {
    title: "Fast-forward merge",
    description: "Add the commits as they are. Needs the branch to contain the base.",
  },
} as const satisfies Record<PullRequestMergeMethod, { title: string; description: string }>;

export function pullRequestActionLabel(
  action: PullRequestAction,
  terminology: ChangeRequestTerminology,
  t: Translator, // fork: i18n
): string {
  const { singular } = terminology;
  switch (action) {
    case "merge":
      return t("Merge {singular}", { singular: changeRequestTerm(singular, t) });
    case "ready":
      return t("Mark ready for review");
    case "draft":
      return t("Convert to draft");
    case "close":
      return t("Close {singular}", { singular: changeRequestTerm(singular, t) });
    case "reopen":
      return t("Reopen {singular}", { singular: changeRequestTerm(singular, t) });
    case "update-branch":
      return t("Update branch");
    case "enable-auto-merge":
      return t("Enable auto-merge");
    case "disable-auto-merge":
      return t("Disable auto-merge");
    case "revert":
      return t("Create revert {singular}", { singular: changeRequestTerm(singular, t) });
    case "delete-branch":
      return t("Delete branch");
    case "approve-workflows":
      return t("Approve workflows");
  }
}

export const PR_ACTION_ICONS = {
  merge: PullRequestGlyph.merged,
  ready: "checkmark.circle",
  draft: "pencil",
  close: "xmark",
  reopen: "arrow.clockwise",
  "update-branch": "arrow.up.circle",
  "enable-auto-merge": "clock",
  "disable-auto-merge": "xmark",
  revert: "arrow.uturn.backward",
  "delete-branch": "trash",
  "approve-workflows": "checkmark",
} as const satisfies Record<PullRequestAction, AppSymbolName>;

export function allowedMergeMethods(pr: ActionDetail) {
  return pr.capabilities.mergeMethods.filter((method) => pr.mergeCapabilities[method]);
}

export function resolveMergeMethod(
  pr: ActionDetail,
  selected: PullRequestMergeMethod | null,
  projectDefault: PullRequestMergeMethod | null,
  lastUsed: PullRequestMergeMethod | undefined,
) {
  const methods = allowedMergeMethods(pr);
  return (
    [selected, projectDefault, lastUsed, "squash" as const].find(
      (method) => method != null && methods.includes(method),
    ) ?? methods[0]
  );
}

export function allowedUpdateMethods(pr: ActionDetail) {
  return (pr.capabilities.updateMethods ?? []).filter((method) =>
    pr.viewerPermissions.updateMethods?.includes(method),
  );
}

export function canPerformPullRequestAction(pr: ActionDetail, action: PullRequestAction) {
  if (!pr.capabilities.actions.includes(action) || !pr.viewerPermissions.actions.includes(action))
    return false;
  if (action === "reopen") return pr.state === "closed";
  if (action === "revert") return pr.state === "merged";
  if (action === "delete-branch")
    return pr.state !== "open" && pr.capabilities.deleteBranch === true;
  if (pr.state !== "open") return false;
  switch (action) {
    case "update-branch":
      return allowedUpdateMethods(pr).length > 0;
    case "approve-workflows":
      return (pr.workflowApprovalsRequired ?? 0) > 0;
    case "ready":
      return pr.isDraft;
    case "draft":
      return !pr.isDraft;
    case "merge":
      return !pr.isDraft && pr.mergeability !== "conflicting" && allowedMergeMethods(pr).length > 0;
    case "enable-auto-merge":
      return !pr.isDraft && pr.autoMergeEnabled === false && allowedMergeMethods(pr).length > 0;
    case "disable-auto-merge":
      return pr.autoMergeEnabled === true;
    default:
      return true;
  }
}

export function mergeUnavailableReason(
  pr: ActionDetail,
  connectionAllowsWrites: boolean,
  terminology: ChangeRequestTerminology,
  t: Translator, // fork: i18n
) {
  const { singular } = terminology;
  if (pr.state === "merged")
    return t("This {singular} has been merged.", { singular: changeRequestTerm(singular, t) });
  if (pr.state === "closed")
    return t("Reopen this {singular} before merging.", {
      singular: changeRequestTerm(singular, t),
    });
  if (!connectionAllowsWrites) return t("This environment connection is read-only.");
  if (!pr.capabilities.actions.includes("merge"))
    return t("This provider does not support merging here.");
  if (!pr.viewerPermissions.actions.includes("merge"))
    return t("Your account cannot merge this {singular}.", {
      singular: changeRequestTerm(singular, t),
    });
  if (pr.isDraft) return t("Mark this draft ready for review before merging.");
  if (pr.mergeability === "conflicting") return t("Resolve the branch conflicts before merging.");
  if (!allowedMergeMethods(pr).length) return t("This repository has no available merge methods.");
  return null;
}

export const openOnProviderLabel = (provider: SourceControlProviderKind, t: Translator) =>
  t("Open on {label}", {
    label: sourceControlClients.get(provider).label,
  });
