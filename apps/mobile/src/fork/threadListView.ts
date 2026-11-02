// fork: T3 Extend's thread list views on mobile. The choice and the folds persist on the device.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SidebarViewMode } from "@t3tools/client-runtime/state/thread-grouping";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../state/preferences";

/** Search lists matches by rank, so a search leaves the grouped layout until it is cleared. */
export function isGroupedByProject(viewMode: SidebarViewMode, searchQuery: string): boolean {
  return viewMode === "project" && searchQuery.trim().length === 0;
}

export function useThreadListViewPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const stored = loaded ? preferencesResult.value : null;
  const viewMode: SidebarViewMode = stored?.threadListViewMode ?? "status";
  const collapsedList = stored?.threadListCollapsedGroups;
  const collapsedKeys = useMemo<ReadonlySet<string>>(
    () => new Set(collapsedList ?? []),
    [collapsedList],
  );

  const setViewMode = (mode: SidebarViewMode) => {
    if (!loaded) return;
    savePreferences({ threadListViewMode: mode });
  };
  // Transforms read optimistic state, so two presses in one frame toggle twice.
  const toggleGroup = (collapseKey: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const collapsed = current.threadListCollapsedGroups ?? [];
        return {
          threadListCollapsedGroups: collapsed.includes(collapseKey)
            ? collapsed.filter((key) => key !== collapseKey)
            : [...collapsed, collapseKey],
        };
      },
    });
  };

  return { loaded, viewMode, collapsedKeys, setViewMode, toggleGroup } as const;
}
