// fork: T3 Extend's thread list views on mobile. The choice and the folds persist on the device.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SidebarViewMode } from "@t3tools/client-runtime/state/thread-grouping";
import { useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../state/preferences";
import { toggleCollapsedKey, useThreadListViewState } from "./threadListViewState";

/** Search lists matches by rank, so a search leaves the grouped layout until it is cleared. */
export function isGroupedByProject(viewMode: SidebarViewMode, searchQuery: string): boolean {
  return viewMode === "project" && searchQuery.trim().length === 0;
}

export function useThreadListViewPreferences() {
  const state = useThreadListViewState(useAtomValue(mobilePreferencesAtom));
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  // `loaded` gates drawing; `writable` gates choices, which must not overwrite unread preferences.
  const { ready: loaded, writable, viewMode, collapsed: collapsedList } = state;
  const collapsedKeys = useMemo<ReadonlySet<string>>(
    () => new Set(collapsedList ?? []),
    [collapsedList],
  );

  const setViewMode = (mode: SidebarViewMode) => {
    if (!writable) return;
    savePreferences({ threadListViewMode: mode });
  };
  // Transforms read optimistic state, so two presses in one frame toggle twice.
  const toggleGroup = (collapseKey: string) => {
    if (!writable) return;
    savePreferences({
      transform: (current) => ({
        threadListCollapsedGroups: toggleCollapsedKey(
          current.threadListCollapsedGroups ?? [],
          collapseKey,
        ),
      }),
    });
  };

  return { loaded, viewMode, collapsedKeys, setViewMode, toggleGroup } as const;
}
