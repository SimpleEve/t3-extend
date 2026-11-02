// fork: T3 Extend's thread list views on mobile. The choice and the folds persist on the device.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SidebarViewMode } from "@t3tools/client-runtime/state/thread-grouping";
import { useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../state/preferences";
import { useThreadListViewState } from "./threadListViewState";

/** Search lists matches by rank, so a search leaves the grouped layout until it is cleared. */
export function isGroupedByProject(viewMode: SidebarViewMode, searchQuery: string): boolean {
  return viewMode === "project" && searchQuery.trim().length === 0;
}

export function useThreadListViewPreferences() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const { ready, viewMode, collapsed, setViewMode, toggleGroup } = useThreadListViewState(
    useAtomValue(mobilePreferencesAtom),
    savePreferences,
  );
  const collapsedKeys = useMemo<ReadonlySet<string>>(() => new Set(collapsed ?? []), [collapsed]);
  // `loaded` gates drawing; choices made before the preference arrives are kept and applied then.
  return { loaded: ready, viewMode, collapsedKeys, setViewMode, toggleGroup } as const;
}
