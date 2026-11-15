import type {
  GitRunStackedActionResult,
  GitStackedAction,
  ReviewDiffPreviewSource,
  VcsStatusResult,
} from "@t3tools/contracts";
import { looksLikeTemporaryWorktreeBranch } from "@t3tools/shared/git"; // fork: display-only predicate
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { translatorFor, type Translator, type UiLocale } from "@t3tools/client-runtime/i18n";
import {
  changeRequestTerminologyFor,
  type DefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
  type GitDialogAction,
} from "@t3tools/client-runtime/state/vcs";

export {
  requiresDefaultBranchConfirmation,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
} from "@t3tools/client-runtime/state/vcs";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface GitActionProgressPresentation {
  readonly status: string;
  readonly output: string | null;
  readonly startedAtMs: number | null;
}

export interface GitActionResultToastTiming {
  readonly timeout: 0;
  readonly dismissAfterVisibleMs: number | null;
}

export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

/**
 * fork: the host's word for a change request inside a sentence. English keeps "pull request" or
 * "merge request"; other languages use the short label (PR, MR), as the glossary does.
 */
export function changeRequestNoun(terminology: ChangeRequestTerminology, locale: UiLocale): string {
  return locale === "en" ? terminology.singular : terminology.shortLabel;
}

export function resolveGitActionResultToastTiming(
  type: "error" | "success",
): GitActionResultToastTiming {
  return {
    timeout: 0,
    dismissAfterVisibleMs: type === "success" ? GIT_ACTION_SUCCESS_VISIBLE_MS : null,
  };
}

export function resolveGitActionProgressPresentation(input: {
  readonly isRunning: boolean;
  readonly operation: string | null;
  readonly currentLabel: string | null;
  readonly lastOutputLine: string | null;
  readonly phaseStartedAtMs: number | null;
  readonly hookStartedAtMs: number | null;
  readonly locale?: UiLocale; // fork: interface language
}): GitActionProgressPresentation | null {
  const t = translatorFor(input.locale ?? "en");
  if (
    !input.isRunning ||
    (input.operation !== "run_change_request" && input.operation !== "pull")
  ) {
    return null;
  }

  const currentLabel = input.currentLabel?.trim();
  const output = input.lastOutputLine?.trim();
  const isPull = input.operation === "pull";
  return {
    status:
      currentLabel && currentLabel !== "Running source control action"
        ? currentLabel
        : isPull
          ? t("Pulling latest changes...")
          : t("Starting source control action..."),
    output: !isPull && output ? output : null,
    startedAtMs: isPull
      ? input.phaseStartedAtMs
      : (input.hookStartedAtMs ?? input.phaseStartedAtMs),
  };
}

export function formatGitActionElapsed(startedAtMs: number | null, nowMs: number): string | null {
  if (startedAtMs === null) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
  locale: UiLocale = "en", // fork: interface language
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);
  const t = translatorFor(locale);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: t("Commit"),
    disabled: !canCommit,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  };

  if (!hasPrimaryRemote) {
    return [commitItem];
  }

  const pushItem: GitActionMenuItem = {
    id: "push",
    label: t("Push"),
    disabled: !canPush,
    icon: "push",
    kind: "open_dialog",
    dialogAction: "push",
  };

  if (hasOpenPr) {
    return [commitItem, pushItem];
  }

  return [
    commitItem,
    pushItem,
    {
      id: "pr",
      label: t("Create {pr}", { pr: terminology.shortLabel }),
      disabled: !canCreatePr,
      icon: "pr",
      kind: "open_dialog",
      dialogAction: "create_pr",
    },
  ];
}

export function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasPrimaryRemote,
  t,
  kindLabel,
}: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
  t: Translator; // fork: interface language
  kindLabel: (terminology: ChangeRequestTerminology) => string; // fork
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return t("Git action in progress.");
  if (!gitStatus) return t("Git status is unavailable.");

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (item.id === "commit") {
    if (!hasChanges) {
      return t("Worktree is clean. Make changes before committing.");
    }
    return t("Commit is currently unavailable.");
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return t("Detached HEAD: check out a branch before pushing.");
    }
    if (isBehind) {
      return t("Branch is behind upstream. Pull/rebase before pushing.");
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return t('Add an "origin" remote before pushing.');
    }
    if (!isAhead) {
      return t("No local commits to push.");
    }
    return t("Push is currently unavailable.");
  }

  const kind = kindLabel(terminology);
  if (!hasBranch) {
    return t("Detached HEAD: check out a branch before creating a {kind}.", { kind });
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return t('Add an "origin" remote before creating a {kind}.', { kind });
  }
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0) {
    return t("No local commits to include in a {kind}.", { kind });
  }
  if (isBehind) {
    return t("Branch is behind upstream. Pull/rebase before creating a {kind}.", { kind });
  }
  return t("Create {kind} is currently unavailable.", { kind });
}

export function hasUsableGitMenuContent(input: {
  readonly menuItems: readonly GitActionMenuItem[];
  readonly canWriteSourceControl: boolean;
  readonly canPublishRepository: boolean;
  readonly hasNotice: boolean;
}): boolean {
  return (
    input.canPublishRepository ||
    input.hasNotice ||
    (input.canWriteSourceControl && input.menuItems.some((item) => !item.disabled))
  );
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
  locale: UiLocale = "en", // fork: interface language
): GitQuickAction {
  const t = translatorFor(locale);
  if (isBusy) {
    return {
      label: t("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("Git action in progress."),
    };
  }

  if (!gitStatus) {
    return {
      label: t("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("Git status is unavailable."),
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (!hasBranch) {
    return {
      label: t("Commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("Create and checkout a ref before pushing or opening a {kind}.", {
        kind: changeRequestNoun(terminology, locale),
      }),
    };
  }

  if (hasChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasPrimaryRemote)) {
      return { label: t("Commit"), disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: t("Commit & push"),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: t("Commit, push & {pr}", { pr: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      return {
        label: t("Publish repository"),
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: t("Commit"),
          disabled: true,
          kind: "show_hint",
          hint: t("Branch is up to date. No action needed."),
        };
      }
      return {
        label: t("Push"),
        disabled: true,
        kind: "show_hint",
        hint: t("No local commits to push."),
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: t("Push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: t("Push & create {pr}", { pr: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: t("Sync ref"),
      disabled: true,
      kind: "show_hint",
      hint: t("Branch has diverged from upstream. Rebase/merge first."),
    };
  }

  if (isBehind) {
    return {
      label: t("Pull"),
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: t("Push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: t("Push & create {pr}", { pr: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Branch is up to date. No action needed.",
    };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: t("Create {pr}", { pr: terminology.shortLabel }),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: t("Commit"),
    disabled: true,
    kind: "show_hint",
    hint: t("Branch is up to date. No action needed."),
  };
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology: ChangeRequestTerminology;
  locale?: UiLocale; // fork: interface language
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const locale = input.locale ?? "en";
  const t = translatorFor(locale);
  // fork: whole sentences, so a translation can move the branch name.
  const suffix = t(
    'on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
    { branch: branchLabel },
  );
  const { terminology } = input;
  const pr = terminology.shortLabel;
  const kind = changeRequestNoun(terminology, locale);

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: t("Commit & push to default ref?"),
        description: t("This action will commit and push changes {suffix}", { suffix }),
        continueLabel: t("Commit & push to {branch}", { branch: branchLabel }),
      };
    }
    return {
      title: t("Push to default ref?"),
      description: t("This action will push local commits {suffix}", { suffix }),
      continueLabel: t("Push to {branch}", { branch: branchLabel }),
    };
  }

  if (input.includesCommit) {
    return {
      title: t("Commit, push & create {pr} from default ref?", { pr }),
      description: t("This action will commit, push, and create a {kind} {suffix}", {
        kind,
        suffix,
      }),
      continueLabel: t("Commit, push & create {pr}", { pr }),
    };
  }
  return {
    title: t("Push & create {pr} from default ref?", { pr }),
    description: t("This action will push local commits and create a {kind} {suffix}", {
      kind,
      suffix,
    }),
    continueLabel: t("Push & create {pr}", { pr }),
  };
}

/** The server names a feature branch from the commit it makes, so the action must commit changes. */
export function resolveFeatureBranchUnavailableReason(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  hasWorkingTreeChanges: boolean;
  locale?: UiLocale; // fork: interface language
}): string | null {
  if (!input.hasWorkingTreeChanges) {
    return `There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on ${input.branchName}.`;
  }
  if (input.action === "push" || input.action === "create_pr") {
    return `This action doesn't commit your changes, so a feature branch can't be named. Create a branch yourself or continue on ${input.branchName}.`;
  }
  return null;
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !looksLikeTemporaryWorktreeBranch(input.threadBranch) &&
    looksLikeTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

export type ChangesLineTotals = {
  readonly insertions: number;
  readonly deletions: number;
  /** Ref the counts compare against; `null` means they are uncommitted changes against HEAD. */
  readonly baseRef: string | null;
};

// `branchChanges ?? workingTree` treats `{0,0}` as present, so a zero branch total hid a dirty
// working tree and the Changes row read +0 while Diff still showed the work.
// The Diff panel's branch comparison wins when it has file stats, so a remembered base or
// hidden whitespace reads the same in the row as in the panel.
export function resolveChangesTotals(
  status: VcsStatusResult | null | undefined,
  branchPreview?: ReviewDiffPreviewSource | null,
): ChangesLineTotals | null {
  if (branchPreview?.files) {
    let insertions = 0;
    let deletions = 0;
    for (const file of branchPreview.files) {
      insertions += file.additions;
      deletions += file.deletions;
    }
    return { insertions, deletions, baseRef: branchPreview.baseRef };
  }
  if (!status) return null;
  const branch = status.branchChanges;
  const tree = { ...status.workingTree, baseRef: null };
  const selected =
    branch && (branch.insertions > 0 || branch.deletions > 0)
      ? branch
      : tree.insertions > 0 || tree.deletions > 0
        ? tree
        : (branch ?? tree);
  return {
    insertions: selected.insertions,
    deletions: selected.deletions,
    baseRef: selected.baseRef,
  };
}
