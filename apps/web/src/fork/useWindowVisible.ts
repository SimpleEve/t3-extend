import { useSyncExternalStore } from "react";

import { getDocumentActivity, subscribeDocumentActivity } from "../lib/documentActivity";

/** Whether the tab or window is visible; the footer chips hold no subscription while it is not. */
export function useWindowVisible(): boolean {
  return useSyncExternalStore(
    subscribeDocumentActivity,
    () => getDocumentActivity().visible,
    () => true,
  );
}
