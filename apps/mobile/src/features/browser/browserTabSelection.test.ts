import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PENDING_BROWSER_TAB_TIMEOUT_MS,
  closedBrowserTab,
  composeBrowserTab,
  expirePendingBrowserTab,
  initialBrowserTabSelection,
  leaveNewBrowserTab,
  openedBrowserTab,
  settleBrowserTabSelection,
  shouldCloseBrowser,
  visibleBrowserTab,
  type BrowserTabSelection,
} from "./browserTabSelection";

const tab = (tabId: string, minute: number): PreviewSessionSnapshot =>
  ({
    threadId: "thread-1",
    tabId,
    navStatus: { _tag: "Idle" },
    canGoBack: false,
    canGoForward: false,
    runtime: "server",
    updatedAt: `2026-11-01T00:0${minute}:00.000Z`,
  }) as PreviewSessionSnapshot;

const OPENED_AT = 1_000;
const a = tab("a", 1);
const b = tab("b", 2);
const opened = tab("opened", 3);

/** What the screen shows after rendering `selection` with `tabs`. */
const render = (selection: BrowserTabSelection, tabs: ReadonlyArray<PreviewSessionSnapshot>) => {
  const settled = settleBrowserTabSelection(selection, tabs);
  return {
    selection: settled,
    tabId: visibleBrowserTab(settled, tabs)?.tabId ?? null,
    close: shouldCloseBrowser(settled, tabs),
  };
};

describe("browser tab selection", () => {
  it("waits for the opened tab without closing or switching", () => {
    const fromEmpty = openedBrowserTab("opened", OPENED_AT);
    expect(render(fromEmpty, [])).toMatchObject({
      selection: fromEmpty,
      tabId: null,
      close: false,
    });

    const fromTabs = openedBrowserTab("opened", OPENED_AT);
    expect(render(fromTabs, [a, b])).toMatchObject({
      selection: fromTabs,
      tabId: null,
      close: false,
    });
    expect(expirePendingBrowserTab(fromTabs, OPENED_AT + PENDING_BROWSER_TAB_TIMEOUT_MS - 1)).toBe(
      fromTabs,
    );
  });

  it("selects the opened tab once it arrives", () => {
    const waiting = openedBrowserTab("opened", OPENED_AT);
    expect(render(waiting, [a, b, opened])).toEqual({
      selection: { composing: false, selectedTabId: "opened", pending: null },
      tabId: "opened",
      close: false,
    });
  });

  it.each([
    ["closes the browser with no tabs", [], null, true],
    ["shows the newest tab", [b, a], "b", false],
  ] as const)("ends the wait at the deadline and %s", (_name, tabs, tabId, close) => {
    const waiting = openedBrowserTab("opened", OPENED_AT);
    const expired = expirePendingBrowserTab(waiting, OPENED_AT + PENDING_BROWSER_TAB_TIMEOUT_MS);
    expect(expired.pending).toBeNull();
    expect(render(expired, tabs)).toMatchObject({ tabId, close });
  });

  it("ends the wait when the opened tab closes before it arrives", () => {
    const waiting = openedBrowserTab("opened", OPENED_AT);
    expect(closedBrowserTab(waiting, "a")).toBe(waiting);
    expect(render(closedBrowserTab(waiting, "opened"), [a])).toMatchObject({
      selection: { pending: null, selectedTabId: "a" },
      tabId: "a",
      close: false,
    });
  });

  it("opens another tab beside the open ones", () => {
    const shown = render(initialBrowserTabSelection(null, false), [a, b]);
    expect(shown.tabId).toBe("b");
    expect(composeBrowserTab(shown.selection).composing).toBe(true);
    const waiting = openedBrowserTab("opened", OPENED_AT);
    expect(render(waiting, [a, b]).tabId).toBeNull();
    expect(render(waiting, [a, b, opened]).tabId).toBe("opened");
  });

  it("goes back from the new tab panel to the previous tab, or closes with none", () => {
    const composing = composeBrowserTab(initialBrowserTabSelection("a", false));
    const back = leaveNewBrowserTab(composing, [a, b]);
    expect(back).toEqual({ composing: false, selectedTabId: "a", pending: null });
    expect(back && render(back, [a, b]).tabId).toBe("a");

    expect(leaveNewBrowserTab(initialBrowserTabSelection(null, true), [])).toBeNull();
  });

  it("does not close while the new tab panel is open", () => {
    expect(render(initialBrowserTabSelection(null, true), []).close).toBe(false);
  });
});
