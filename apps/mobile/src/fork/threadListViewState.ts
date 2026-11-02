// fork: what the thread list shows before, and instead of, the saved view preference.
import type { SidebarViewMode } from "@t3tools/client-runtime/state/thread-grouping";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import type { Preferences } from "../persistence/mobile-preferences";

/** How long the list waits for the saved view before it shows the status view. */
export const VIEW_PREFERENCE_GRACE_MS = 1000;

/**
 * Fold keys are never pruned by looking at projects, because an environment that is offline has
 * none loaded and its folds would be lost. The newest folds win instead, which also ages out the
 * keys of deleted projects.
 */
export const MAX_COLLAPSED_GROUPS = 200;

export function toggleCollapsedKey(collapsed: readonly string[], key: string): string[] {
  return collapsed.includes(key)
    ? collapsed.filter((candidate) => candidate !== key)
    : [...collapsed, key].slice(-MAX_COLLAPSED_GROUPS);
}

export interface ThreadListViewState {
  /** False only while the list should draw nothing: the preference is pending, inside the grace. */
  readonly ready: boolean;
  /** The preference was read, so a choice made now cannot overwrite what is stored. */
  readonly writable: boolean;
  readonly viewMode: SidebarViewMode;
  readonly collapsed: readonly string[] | undefined;
  /** The read failed; the list shows the status view and the choice is not saved. */
  readonly failure: { readonly cause: unknown } | null;
}

export function resolveThreadListViewState(
  result: AsyncResult.AsyncResult<Preferences, unknown>,
  graceElapsed: boolean,
): ThreadListViewState {
  if (AsyncResult.isSuccess(result)) {
    return {
      ready: true,
      writable: true,
      viewMode: result.value.threadListViewMode ?? "status",
      collapsed: result.value.threadListCollapsedGroups,
      failure: null,
    };
  }
  return {
    ready: AsyncResult.isFailure(result) || graceElapsed,
    writable: false,
    viewMode: "status",
    collapsed: undefined,
    failure: AsyncResult.isFailure(result) ? { cause: result.cause } : null,
  };
}

// Once the wait has run out, lists mounted later do not wait again.
let graceLatched = false;

export function useThreadListViewState(
  result: AsyncResult.AsyncResult<Preferences, unknown>,
): ThreadListViewState {
  const [graceElapsed, setGraceElapsed] = useState(graceLatched);
  const settled = AsyncResult.isSuccess(result) || AsyncResult.isFailure(result);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer ends the wait for a preference that never arrives
  useEffect(() => {
    if (settled || graceElapsed) return;
    const timer = setTimeout(() => {
      graceLatched = true;
      setGraceElapsed(true);
    }, VIEW_PREFERENCE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [settled, graceElapsed]);
  const state = resolveThreadListViewState(result, graceElapsed || graceLatched);
  const failure = state.failure;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports a failed read once per failure
  useEffect(() => {
    if (failure) {
      console.warn(
        "[thread-list-view] could not read mobile preferences; showing the status view",
        failure.cause,
      );
    }
  }, [failure]);
  return state;
}
