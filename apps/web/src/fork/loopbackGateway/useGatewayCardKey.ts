// fork: which card a preview tab shows, if any. The card draws it and the tab's webview steps aside
// for it, so both read the answer from here.
import type { EnvironmentId } from "@t3tools/contracts";
import { isLoopbackGatewayHost } from "@t3tools/shared/forkLoopbackGateway/hosts";

import { useLoopbackForwardingDisabled } from "./disabledStore";
import { gatewayCardPort, resolveGatewayCardKey } from "./gatewayCard";
import { isLoopbackGatewayHeld } from "./gatewayState";
import { selectGatewayDenial, useGatewayStore } from "./gatewayStore";
import { useLoopbackGatewayState } from "./useLoopbackGatewayState";

const isLoopbackUrl = (url: string): boolean => {
  try {
    return isLoopbackGatewayHost(new URL(url).hostname);
  } catch {
    return false;
  }
};

export function useGatewayCardKey(input: {
  readonly environmentId: EnvironmentId;
  readonly runtimeTabId: string;
  readonly url: string;
  /** The page failed to load at all, as opposed to loading an error page the proxy answered. */
  readonly loadFailed: boolean;
}) {
  const { environmentId, runtimeTabId, url, loadFailed } = input;
  const { state, wasActive, connecting } = useLoopbackGatewayState(environmentId);
  const disabledByUser = useLoopbackForwardingDisabled(environmentId);
  const held = isLoopbackGatewayHeld({ state: state.state, wasActive, disabledByUser });
  const port = gatewayCardPort(url);
  const loopback = isLoopbackUrl(url);
  const denial = useGatewayStore((store) =>
    loopback ? selectGatewayDenial(store, { runtimeTabId, environmentId, port, loadFailed }) : null,
  );
  const registration = useGatewayStore((store) => store.registration[environmentId]);
  const startFailed = state.state === "active" && registration === "failed" && !disabledByUser;
  const key = resolveGatewayCardKey({
    startFailed,
    held,
    connecting,
    denialCode: denial?.code ?? null,
    loadFailed,
    loopback,
    state,
  });
  return { key, port, held, startFailed, denial };
}
