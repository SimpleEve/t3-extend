// fork: tells the desktop main process which remote environments to forward localhost for, and
// keeps their tickets fresh (research/remote-loopback-forwarding.md 4.2, 8, 10). Mounted once at
// the app root; it does nothing without the gateway bridge, which only the desktop app has.
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { useEnvironments } from "~/state/environments";

import { getLoopbackGatewayBridge } from "./bridge";
import { pruneLoopbackForwardingRecords, setLoopbackWasActive } from "./disabledStore";
import { type GatewayController, makeGatewayController } from "./gatewayController";
import {
  forgetGatewayEnvironment,
  noteGatewayDenied,
  noteGatewayTabState,
  noteGatewayTicketDelivered,
  publishGatewayState,
  setGatewayRegistration,
  useGatewayStore,
} from "./gatewayStore";
import { fetchLoopbackGatewayTicket } from "./ticketCommand";
import { useLoopbackGatewayState } from "./useLoopbackGatewayState";

const scheduleOnce = (run: () => void, delayMs: number) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

export function LoopbackGatewayManager() {
  const bridge = getLoopbackGatewayBridge();
  const [controller] = useState<GatewayController | null>(() =>
    bridge === undefined
      ? null
      : makeGatewayController({
          bridge,
          issueTicket: fetchLoopbackGatewayTicket,
          now: Date.now,
          schedule: scheduleOnce,
          onRegistration: setGatewayRegistration,
          onTicketDelivered: noteGatewayTicketDelivered,
        }),
  );
  const { environments, isReady } = useEnvironments();
  const environmentIds = environments.map(({ environmentId }) => environmentId).join("\n");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forgets the stored forwarding state of environments that were removed, once the saved list is known
  useEffect(() => {
    if (isReady)
      pruneLoopbackForwardingRecords(
        new Set(environmentIds === "" ? [] : environmentIds.split("\n")),
      );
  }, [isReady, environmentIds]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to the Electron main process's gateway events for as long as the app runs
  useEffect(() => {
    if (bridge === undefined || controller === null) return;
    const stopEvents = bridge.onEvent((event) => {
      if (event.type === "ticket-needed") controller.ticketNeeded(event.environmentId);
      else if (event.type === "denied") {
        noteGatewayDenied({
          environmentId: event.environmentId,
          code: event.code,
          port: event.port,
          webContentsId: event.mainFrame ? event.webContentsId : undefined,
        });
      }
    });
    // A refusal belongs to the load that caused it, so the store needs to see each tab load begin.
    const stopTabs = previewBridge?.onStateChange((runtimeTabId, state) =>
      noteGatewayTabState({
        runtimeTabId,
        webContentsId: state.webContentsId,
        loading: state.navStatus.kind === "Loading",
      }),
    );
    return () => {
      stopEvents();
      stopTabs?.();
      controller.dispose();
    };
  }, [bridge, controller]);

  if (controller === null) return null;
  return (
    <>
      {environments.map(({ environmentId }) => (
        <EnvironmentGateway
          key={environmentId}
          environmentId={environmentId}
          controller={controller}
        />
      ))}
    </>
  );
}

function EnvironmentGateway(props: {
  readonly environmentId: EnvironmentId;
  readonly controller: GatewayController;
}) {
  const { environmentId, controller } = props;
  const { inputs, state, connected } = useLoopbackGatewayState(environmentId);
  const forwarded = state.state === "active" || state.state === "disabled-by-user";
  const httpBaseUrl = forwarded ? (inputs.route?.httpBaseUrl ?? null) : null;
  const enabled = state.state === "active";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the derived state for code outside React, such as the URL resolver
  useEffect(() => {
    publishGatewayState(environmentId, state.state);
    // What is stored is what the next start has to go on, so only a settled answer changes it: the
    // user's own switch keeps it, and an environment that cannot forward is forgotten.
    if (state.state === "active") setLoopbackWasActive(environmentId, true);
    else if (state.state !== "unknown" && state.state !== "disabled-by-user") {
      setLoopbackWasActive(environmentId, false);
    }
  }, [environmentId, state.state]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the environment with the Electron main process, which owns the proxy
  useEffect(() => {
    controller.sync(
      environmentId,
      httpBaseUrl === null ? null : { httpBaseUrl, enabled, reachable: connected },
    );
  }, [controller, environmentId, httpBaseUrl, enabled, connected]);

  const retryRequests = useGatewayStore((store) => store.retryRequests[environmentId] ?? 0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the user's retry of a failed registration is carried out by the controller, which lives outside React
  useEffect(() => {
    if (retryRequests > 0) controller.retry(environmentId);
  }, [controller, environmentId, retryRequests]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the environment's proxy when it leaves the app
  useEffect(
    () => () => {
      controller.sync(environmentId, null);
      forgetGatewayEnvironment(environmentId);
    },
    [controller, environmentId],
  );

  return null;
}
