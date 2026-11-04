// fork: the gate in front of a preview tab's webview (research/remote-loopback-forwarding.md 2.3).
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useLoopbackForwardingDisabled } from "./disabledStore";
import { isLoopbackGatewayReady } from "./gatewayState";
import { useGatewayStore } from "./gatewayStore";
import { useLoopbackGatewayState } from "./useLoopbackGatewayState";

/** True from the first render that sees `value` true, whatever `value` does after that. */
export function useLatched(value: boolean): boolean {
  const [latched, setLatched] = useState(false);
  if (value && !latched) setLatched(true);
  return latched || value;
}

/**
 * Whether a tab of this environment may create its webview (`isLoopbackGatewayReady`). Once open it
 * stays open: a dropped connection must not tear a page down.
 */
export function useLoopbackGatewayReady(environmentId: EnvironmentId): boolean {
  const { state, connecting, wasActive } = useLoopbackGatewayState(environmentId);
  const disabledByUser = useLoopbackForwardingDisabled(environmentId);
  const registration = useGatewayStore((store) => store.registration[environmentId]);
  return useLatched(
    isLoopbackGatewayReady({
      state: state.state,
      connecting,
      registration,
      wasActive,
      disabledByUser,
    }),
  );
}
