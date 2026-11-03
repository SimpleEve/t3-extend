import { useEffect } from "react";

import { useQuietThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useFooterStatusToggle } from "./footerStatusStore";
import { getKeepAwakeBridge } from "./keepAwakeBridge";
import { hasRunningLocalThread, shouldKeepAwake } from "./keepAwake.logic";

/**
 * Tells the desktop main process whether a thread on this computer is running. Mounted once at
 * the app root so it survives navigation; main also lets go on its own if this page goes away.
 */
export function KeepAwakeReporter() {
  const bridge = getKeepAwakeBridge();
  const enabled = useFooterStatusToggle("keepAwake");
  const localEnvironmentId = usePrimaryEnvironmentId();
  const threads = useQuietThreadShells();
  const keepAwake = shouldKeepAwake({
    enabled,
    hasBridge: bridge !== undefined,
    localThreadRunning: hasRunningLocalThread(threads, localEnvironmentId),
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports to the Electron main process, which holds the OS power block
  useEffect(() => {
    if (bridge === undefined) return;
    void bridge.setActive(keepAwake).catch(() => {});
    return () => void bridge.setActive(false).catch(() => {});
  }, [bridge, keepAwake]);

  return null;
}
