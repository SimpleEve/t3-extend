import {
  isSidebarViewMode,
  type SidebarViewMode,
} from "@t3tools/client-runtime/state/thread-grouping";
import { create } from "zustand";

// fork: per-device sidebar view, kept out of ClientSettings so contracts stay upstream's.
const STORAGE_KEY = "t3extend:sidebar-view:v1";

interface PersistedSidebarView {
  readonly mode: SidebarViewMode;
  /** Fold keys from `sidebarGroupCollapseKey`; groups are open unless listed. */
  readonly collapsed: readonly string[];
}

const DEFAULT_VIEW: PersistedSidebarView = { mode: "status", collapsed: [] };

function readPersisted(): PersistedSidebarView {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEW;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_VIEW;
    const { mode, collapsed } = parsed as Record<string, unknown>;
    return {
      mode: isSidebarViewMode(mode) ? mode : DEFAULT_VIEW.mode,
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
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: state.mode, collapsed: state.collapsed }),
    );
  } catch {}
}

export const useSidebarViewStore = create<PersistedSidebarView>(() =>
  typeof window === "undefined" ? DEFAULT_VIEW : readPersisted(),
);

export function useSidebarViewMode(): SidebarViewMode {
  return useSidebarViewStore((state) => state.mode);
}

/** For handlers outside React, such as keybinding commands. */
export function getSidebarViewMode(): SidebarViewMode {
  return useSidebarViewStore.getState().mode;
}

export function setSidebarViewMode(mode: SidebarViewMode) {
  if (useSidebarViewStore.getState().mode === mode) return;
  useSidebarViewStore.setState({ mode });
  persist(useSidebarViewStore.getState());
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
