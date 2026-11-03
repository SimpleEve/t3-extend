import { KEEP_AWAKE_BRIDGE_GLOBAL, type KeepAwakeBridge } from "@t3tools/shared/keepAwake";

// fork: desktop keep-awake. Only the desktop renderer has this bridge.
export function getKeepAwakeBridge(): KeepAwakeBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, KeepAwakeBridge | undefined>)[
    KEEP_AWAKE_BRIDGE_GLOBAL
  ];
}
