import type { PreviewSessionSnapshot } from "@t3tools/contracts";

import { latestBrowserTab } from "./browserTabs";

// A tab closed before its event arrives, or an event lost across a reconnect, never lands.
export const PENDING_BROWSER_TAB_TIMEOUT_MS = 10_000;

export interface BrowserTabSelection {
  readonly composing: boolean;
  readonly selectedTabId: string | null;
  /** The tab `preview.open` returned, until it shows up in the tab list or its wait ends. */
  readonly pending: { readonly tabId: string; readonly deadline: number } | null;
}

type Tabs = ReadonlyArray<PreviewSessionSnapshot>;

export function initialBrowserTabSelection(
  selectedTabId: string | null,
  composing: boolean,
): BrowserTabSelection {
  return { composing, selectedTabId, pending: null };
}

/** The tab to show; none while the opened tab has not arrived yet. */
export function visibleBrowserTab(selection: BrowserTabSelection, tabs: Tabs) {
  return (
    tabs.find((tab) => tab.tabId === selection.selectedTabId) ??
    (selection.pending === null ? latestBrowserTab(tabs) : null)
  );
}

/** Ends the wait once the opened tab arrives, and follows the newest tab when the selected one is gone. */
export function settleBrowserTabSelection(
  selection: BrowserTabSelection,
  tabs: Tabs,
): BrowserTabSelection {
  if (selection.pending !== null) {
    const pendingTabId = selection.pending.tabId;
    if (!tabs.some((tab) => tab.tabId === pendingTabId)) return selection;
    return { ...selection, selectedTabId: pendingTabId, pending: null };
  }
  const tabId = visibleBrowserTab(selection, tabs)?.tabId ?? null;
  return tabId === null || tabId === selection.selectedTabId
    ? selection
    : { ...selection, selectedTabId: tabId };
}

export function openedBrowserTab(tabId: string, now: number): BrowserTabSelection {
  return {
    composing: false,
    selectedTabId: tabId,
    pending: { tabId, deadline: now + PENDING_BROWSER_TAB_TIMEOUT_MS },
  };
}

/** Drops the wait once its deadline passes; the caller reports the tab that never opened. */
export function expirePendingBrowserTab(
  selection: BrowserTabSelection,
  now: number,
): BrowserTabSelection {
  if (selection.pending === null || now < selection.pending.deadline) return selection;
  return { ...selection, selectedTabId: null, pending: null };
}

/** The server closed the tab we are waiting for, so it will never arrive. */
export function closedBrowserTab(
  selection: BrowserTabSelection,
  tabId: string,
): BrowserTabSelection {
  if (selection.pending?.tabId !== tabId) return selection;
  return { ...selection, selectedTabId: null, pending: null };
}

export function composeBrowserTab(selection: BrowserTabSelection): BrowserTabSelection {
  return { ...selection, composing: true };
}

export function selectBrowserTab(tabId: string): BrowserTabSelection {
  return { composing: false, selectedTabId: tabId, pending: null };
}

/** Back from the new tab panel returns to the open tabs; `null` means close the browser. */
export function leaveNewBrowserTab(
  selection: BrowserTabSelection,
  tabs: Tabs,
): BrowserTabSelection | null {
  return tabs.length > 0 ? { ...selection, composing: false } : null;
}

export function shouldCloseBrowser(selection: BrowserTabSelection, tabs: Tabs) {
  return tabs.length === 0 && !selection.composing && selection.pending === null;
}
