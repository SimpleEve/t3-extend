// fork: tells the user at launch when the background service did not start at the last quit.
import { translate, getUiLocale } from "@t3tools/client-runtime/i18n";
import { useEffect } from "react";

import { toastManager } from "../components/ui/toast";
import { getBackgroundServiceBridge } from "./backgroundServiceBridge";

/** Mounted once at the app root; the settings row keeps showing the failure and offers the retry. */
export function BackgroundServiceReporter() {
  const bridge = getBackgroundServiceBridge();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the launch agent's state from the Electron main process once
  useEffect(() => {
    void bridge
      ?.getState()
      .then((state) => {
        if (state.kind !== "attention" || state.problem !== "resume-failed") return;
        toastManager.add({
          type: "error",
          title: translate(getUiLocale(), "The background service did not start"),
          description: translate(
            getUiLocale(),
            "It could not start when you last quit, so T3 Extend stopped with the app. Open Settings, General to retry. {reason}",
            { reason: state.reason ?? "" },
          ),
        });
      })
      .catch(() => {});
  }, [bridge]);

  return null;
}
