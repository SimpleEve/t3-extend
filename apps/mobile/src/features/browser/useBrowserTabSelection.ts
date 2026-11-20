import { useAtomSubscribe } from "@effect/atom-react";
import type {
  EnvironmentId,
  PreviewEvent,
  PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useEffectEvent, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { useT } from "../../hooks/useT";
import { useHardwareBack } from "../../lib/backHandler";
import { previewEnvironment } from "../../state/preview";
import {
  closedBrowserTab,
  composeBrowserTab,
  expirePendingBrowserTab,
  initialBrowserTabSelection,
  leaveNewBrowserTab,
  openedBrowserTab,
  selectBrowserTab,
  settleBrowserTabSelection,
  shouldCloseBrowser,
  visibleBrowserTab,
  type BrowserTabSelection,
} from "./browserTabSelection";

/**
 * The browser screen's tab, new tab panel, and the wait for a tab it just opened.
 * `onSelectedTabChange` runs whenever the shown tab changes, so the screen can reset per-tab state.
 */
export function useBrowserTabSelection(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabs: ReadonlyArray<PreviewSessionSnapshot>;
  readonly initialTabId: string | null;
  readonly startWithNewTab: boolean;
  /** `initialTabId` was just opened and may not be in `tabs` yet. */
  readonly awaitInitialTab: boolean;
  readonly onSelectedTabChange: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const { environmentId, threadId, tabs, onSelectedTabChange } = input;
  const [selection, setSelection] = useState(() =>
    input.awaitInitialTab && input.initialTabId !== null
      ? openedBrowserTab(input.initialTabId, Date.now())
      : initialBrowserTabSelection(input.initialTabId, input.startWithNewTab),
  );
  const update = (next: BrowserTabSelection) => {
    if (next === selection) return;
    if (next.selectedTabId !== selection.selectedTabId) onSelectedTabChange();
    setSelection(next);
  };
  const settled = settleBrowserTabSelection(selection, tabs);
  if (settled !== selection) update(settled);

  const expire = useEffectEvent(() => {
    const next = expirePendingBrowserTab(selection, Date.now());
    if (next === selection) return;
    update(next);
    Dialog.alert(t("The browser tab did not open"));
  });
  const deadline = selection.pending?.deadline ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- times out the wait for an opened tab that never reaches the tab list
  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);

  const pendingTabId = selection.pending?.tabId ?? null;
  const onPreviewEvent = useCallback(
    (result: AsyncResult.AsyncResult<PreviewEvent, unknown>) => {
      if (pendingTabId === null || !AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type !== "closed" || event.threadId !== threadId) return;
      if (event.tabId !== pendingTabId) return;
      setSelection((current) => closedBrowserTab(current, event.tabId));
      Dialog.alert(t("The browser tab did not open"));
    },
    [pendingTabId, threadId, t],
  );
  useAtomSubscribe(previewEnvironment.events({ environmentId, input: {} }), onPreviewEvent);

  const leave = () => {
    const next = leaveNewBrowserTab(selection, tabs);
    if (next === null) input.onClose();
    else update(next);
  };
  // Back leaves the panel for the open tabs; with none open it closes the browser.
  useHardwareBack(selection.composing && tabs.length > 0, () => {
    leave();
    return true;
  });

  return {
    tab: visibleBrowserTab(selection, tabs),
    composing: selection.composing,
    shouldClose: shouldCloseBrowser(selection, tabs),
    compose: () => update(composeBrowserTab(selection)),
    opened: (tabId: string) => update(openedBrowserTab(tabId, Date.now())),
    select: (tabId: string) => update(selectBrowserTab(tabId)),
    leave,
  };
}
