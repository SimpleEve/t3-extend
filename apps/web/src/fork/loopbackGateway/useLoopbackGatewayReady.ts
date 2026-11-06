// fork: the gate in front of a preview tab's webview (research/remote-loopback-forwarding.md 2.3).
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useLoopbackForwardingDisabled } from "./disabledStore";
import { type GateLatch, nextGateLatch } from "./gatewayState";
import { useGatewayStore } from "./gatewayStore";
import { useLoopbackGatewayState } from "./useLoopbackGatewayState";

/**
 * Whether a tab of this environment may have its webview (`isLoopbackGatewayReady`). A page opened
 * behind the proxy stays open through a dropped connection; one opened without it goes when
 * forwarding starts (`nextGateLatch`). `canOperate` is whether the webview is built at all.
 */
export function useLoopbackGatewayReady(
  environmentId: EnvironmentId,
  canOperate: boolean,
): boolean {
  const { state, connecting, wasActive } = useLoopbackGatewayState(environmentId);
  const disabledByUser = useLoopbackForwardingDisabled(environmentId);
  const registration = useGatewayStore((store) => store.registration[environmentId]);
  const [latch, setLatch] = useState<GateLatch>("closed");
  const next = nextGateLatch(latch, {
    state: state.state,
    connecting,
    registration,
    wasActive,
    disabledByUser,
    canOperate,
  });
  if (next !== latch) setLatch(next);
  return next !== "closed";
}
