// fork: what the thread list shows before, and instead of, the saved view preference.
import type { SidebarViewMode } from "@t3tools/client-runtime/state/thread-grouping";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { Preferences } from "../persistence/mobile-preferences";
import { setCollapsedKey, toggleCollapsedKey } from "./threadListCollapse";

/** The view of a device that never chose one; a pending or failed read still shows the status view. */
const DEFAULT_VIEW_MODE: SidebarViewMode = "project";

/** How long the list waits for the saved view before it shows the status view. */
export const VIEW_PREFERENCE_GRACE_MS = 1000;

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
      viewMode: result.value.threadListViewMode ?? DEFAULT_VIEW_MODE,
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

/** What the user chose while the saved view was not read yet; it wins over the saved value. */
interface ViewIntent {
  readonly viewMode: SidebarViewMode | null;
  /** Fold state the user set per key; absolute, so it does not flip when the saved list differs. */
  readonly folds: Readonly<Record<string, boolean>>;
}

const NO_INTENT: ViewIntent = { viewMode: null, folds: {} };

// Module-level on purpose: the view lives in the one device-wide preferences store, not per environment, so every list and menu shares this pending choice and the grace.
let intent = NO_INTENT;
const intentListeners = new Set<() => void>();

function setIntent(next: ViewIntent) {
  intent = next;
  for (const listener of intentListeners) listener();
}

function subscribeIntent(listener: () => void) {
  intentListeners.add(listener);
  return () => {
    intentListeners.delete(listener);
  };
}

const getIntent = () => intent;

// A function, not a read of `intent` before a write: the compiler may reorder module reads.
function takeViewIntent(): ViewIntent | null {
  const taken = intent;
  if (!hasIntent(taken)) return null;
  setIntent(NO_INTENT);
  return taken;
}

const hasIntent = (value: ViewIntent) =>
  value.viewMode !== null || Object.keys(value.folds).length > 0;

/** The saved preference with the user's earlier choices applied on top. */
function applyViewIntent(stored: Preferences, choices: ViewIntent): Partial<Preferences> {
  return {
    ...(choices.viewMode === null ? {} : { threadListViewMode: choices.viewMode }),
    ...(Object.keys(choices.folds).length === 0
      ? {}
      : {
          threadListCollapsedGroups: foldChoices(stored.threadListCollapsedGroups ?? [], choices),
        }),
  };
}

function foldChoices(collapsed: readonly string[], choices: ViewIntent): string[] {
  return Object.entries(choices.folds).reduce(
    (list, [key, folded]) => setCollapsedKey(list, key, folded),
    [...collapsed],
  );
}

type ViewUpdate =
  | Partial<Preferences>
  | { readonly transform: (current: Preferences) => Partial<Preferences> };

// Once the wait has run out, lists mounted later do not wait again.
let graceLatched = false;

export function useThreadListViewState(
  result: AsyncResult.AsyncResult<Preferences, unknown>,
  save: (update: ViewUpdate) => void,
) {
  const [graceElapsed, setGraceElapsed] = useState(graceLatched);
  const choices = useSyncExternalStore(subscribeIntent, getIntent, getIntent);
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
  // The result keeps its identity between renders, so a failure is reported once.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports a failed read
  useEffect(() => {
    if (AsyncResult.isFailure(result)) {
      console.warn(
        "[thread-list-view] could not read mobile preferences; showing the status view",
        result.cause,
      );
    }
  }, [result]);
  const state = resolveThreadListViewState(result, graceElapsed || graceLatched);
  const { writable } = state;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves what the user chose before the saved view arrived
  useEffect(() => {
    if (!writable) return;
    const taken = takeViewIntent();
    if (taken === null) return;
    save({ transform: (current) => applyViewIntent(current, taken) });
  }, [writable, save]);

  const viewMode = choices.viewMode ?? state.viewMode;
  const collapsed =
    Object.keys(choices.folds).length === 0
      ? state.collapsed
      : foldChoices(state.collapsed ?? [], choices);

  const setViewMode = (mode: SidebarViewMode) => {
    if (writable) save({ threadListViewMode: mode });
    else setIntent({ ...intent, viewMode: mode });
  };
  // Transforms read optimistic state, so two presses in one frame toggle twice.
  const toggleGroup = (collapseKey: string) => {
    if (writable) {
      save({
        transform: (current) => ({
          threadListCollapsedGroups: toggleCollapsedKey(
            current.threadListCollapsedGroups ?? [],
            collapseKey,
          ),
        }),
      });
    } else {
      // What the user sees now is the saved list with their earlier choices, so flip that.
      const folded = collapsed?.includes(collapseKey) === true;
      setIntent({ ...intent, folds: { ...intent.folds, [collapseKey]: !folded } });
    }
  };

  return { ready: state.ready, viewMode, collapsed, setViewMode, toggleGroup } as const;
}
