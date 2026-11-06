import {
  LOOPBACK_GATEWAY_BRIDGE_GLOBAL,
  type LoopbackGatewayBridge,
} from "@t3tools/shared/forkLoopbackGateway/bridge";

// fork: the desktop main process's gateway. Only the desktop app's own window has this bridge, so
// the browser, the mobile app and every preview webview see `undefined` and nothing here applies.
export function getLoopbackGatewayBridge(): LoopbackGatewayBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, LoopbackGatewayBridge | undefined>)[
    LOOPBACK_GATEWAY_BRIDGE_GLOBAL
  ];
}
