import type { SidebarViewMode } from "@t3tools/client-runtime/state/thread-grouping";
import { create } from "zustand";

import { getClientSettings, updateClientSettings, useClientSettings } from "../hooks/useSettings";

// fork: the view is upstream's Boring sidebar setting; only the fold state is fork storage.
const STORAGE_KEY = "t3extend:sidebar-view:v1";

interface PersistedSidebarView {
  /** Fold keys from `sidebarGroupCollapseKey`; groups are open unless listed. */
  readonly collapsed: readonly string[];
}

const DEFAULT_VIEW: PersistedSidebarView = { collapsed: [] };

function readPersisted(): PersistedSidebarView {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEW;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_VIEW;
    // Older data also holds a `mode`; the Boring sidebar setting decides the view now.
    const { collapsed } = parsed as Record<string, unknown>;
    return {
      collapsed: Array.isArray(collapsed)
        ? collapsed.filter((key): key is string => typeof key === "string")
        : [],
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

function persist(state: PersistedSidebarView) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ collapsed: state.collapsed }));
  } catch {}
}

export const useSidebarViewStore = create<PersistedSidebarView>(() =>
  typeof window === "undefined" ? DEFAULT_VIEW : readPersisted(),
);

export function useSidebarViewMode(): SidebarViewMode {
  return useClientSettings((settings) => settings.boringSidebarEnabled) ? "project" : "status";
}

/** For handlers outside React, such as keybinding commands. */
export function getSidebarViewMode(): SidebarViewMode {
  return getClientSettings().boringSidebarEnabled ? "project" : "status";
}

/** Same write as the Labs switch, so the toggle, the palette and Labs always agree. */
export function setSidebarViewMode(mode: SidebarViewMode): Promise<void> {
  return updateClientSettings({ boringSidebarEnabled: mode === "project" });
}

export function toggleSidebarGroupCollapsed(collapseKey: string) {
  const { collapsed } = useSidebarViewStore.getState();
  useSidebarViewStore.setState({
    collapsed: collapsed.includes(collapseKey)
      ? collapsed.filter((key) => key !== collapseKey)
      : [...collapsed, collapseKey],
  });
  persist(useSidebarViewStore.getState());
}
