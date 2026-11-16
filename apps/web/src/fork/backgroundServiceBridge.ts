import {
  BACKGROUND_SERVICE_BRIDGE_GLOBAL,
  type BackgroundServiceBridge,
} from "@t3tools/shared/backgroundService";

// fork: desktop background service. Only the packaged macOS app's renderer has this bridge.
export function getBackgroundServiceBridge(): BackgroundServiceBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, BackgroundServiceBridge | undefined>)[
    BACKGROUND_SERVICE_BRIDGE_GLOBAL
  ];
}
