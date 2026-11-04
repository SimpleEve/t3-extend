// fork: the loopback gateway's state for one environment, read from the live atoms. The manager
// acts on it, the badge and cards show it, and the preview webview waits on it, so they all call
// this and cannot disagree.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { reachesEnvironmentLoopback } from "~/browser/browserTargetResolver";
import { useEnvironment } from "~/state/environments";
import { environmentSession, usePreparedConnection } from "~/state/session";

import { getLoopbackGatewayBridge } from "./bridge";
import {
  type LoopbackGatewayInputs,
  isLoopbackGatewayReady,
  resolveLoopbackGatewayState,
} from "./gatewayState";
import { useGatewayStore } from "./gatewayStore";
import { useLoopbackForwardingDisabled } from "./disabledStore";
import { issueLoopbackGatewayTicket } from "./ticketCommand";

export function useLoopbackGatewayState(environmentId: EnvironmentId) {
  const bridge = getLoopbackGatewayBridge();
  const environment = useEnvironment(environmentId);
  const prepared = usePreparedConnection(environmentId);
  const permitted = useAtomValue(issueLoopbackGatewayTicket.permissionAtom(environmentId));
  const sessionKnown = useAtomValue(
    environmentSession.sessionStateAtom(environmentId),
    (result) => result._tag !== "Initial",
  );
  const disabledByUser = useLoopbackForwardingDisabled(environmentId);

  const capabilities =
    bridge === undefined ? undefined : environment?.serverConfig?.environment.capabilities;
  const inputs: LoopbackGatewayInputs = {
    hasBridge: bridge !== undefined,
    // Without the bridge nothing applies, so nothing else is looked at.
    runsOnThisComputer:
      bridge === undefined ||
      environment === null ||
      reachesEnvironmentLoopback(environment.entry.target),
    route:
      prepared._tag === "Some"
        ? {
            httpBaseUrl: prepared.value.httpBaseUrl,
            relay: prepared.value.target._tag === "RelayConnectionTarget",
          }
        : null,
    capability: capabilities === undefined ? null : capabilities.loopbackGateway === true,
    permission: sessionKnown ? permitted : null,
    disabledByUser,
  };
  const phase = environment?.connection.phase ?? "offline";
  return {
    inputs,
    state: resolveLoopbackGatewayState(inputs),
    connected: phase === "connected",
    /** The environment is on its way to a connection, so what is unknown may soon be known. */
    connecting: phase === "connecting" || phase === "reconnecting" || phase === "connected",
  };
}

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
  const { state, connecting } = useLoopbackGatewayState(environmentId);
  const registration = useGatewayStore((store) => store.registration[environmentId]);
  return useLatched(isLoopbackGatewayReady({ state: state.state, connecting, registration }));
}
