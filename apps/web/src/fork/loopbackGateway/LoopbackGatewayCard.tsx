// fork: the card over a preview tab whose localhost was meant to be forwarded and was not
// (research/remote-loopback-forwarding.md 7.2). It reuses the page-unreachable card with other words.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { PreviewUnreachable } from "~/components/preview/PreviewUnreachable";
import { useT } from "~/hooks/useT";

import {
  allowLoopbackGatewayPort,
  allowLoopbackPort,
  type AllowedPortFailure,
} from "./allowedPorts";
import {
  describeAllowPortFailure,
  describeGatewayCard,
  gatewayCardOffersAllow,
  gatewayCardOffersMove,
} from "./gatewayCard";
import { setLoopbackForwardingDisabled } from "./disabledStore";
import { requestGatewayRetry, useGatewayStore } from "./gatewayStore";
import { useGatewayCardKey } from "./useGatewayCardKey";

/** What a preview tab hands the badge and the card; the badge uses the part it needs. */
export interface LoopbackGatewayTabProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly runtimeTabId: string;
  readonly url: string;
  /** The page failed to load at all, as opposed to loading an error page the proxy answered. */
  readonly loadFailed: boolean;
  readonly onReload: () => void;
  /** Opens the tab in the environment's own browser; absent when that is not possible. */
  readonly move: { readonly label: string; readonly onMove: () => void } | undefined;
}

export function LoopbackGatewayCard(props: LoopbackGatewayTabProps) {
  const { environmentId, environmentLabel, runtimeTabId, url, loadFailed, onReload, move } = props;
  const t = useT();
  const { key, port, held, startFailed, denial } = useGatewayCardKey({
    environmentId,
    runtimeTabId,
    url,
    loadFailed,
  });

  const ticketsDelivered = useGatewayStore((store) => store.ticketGeneration[environmentId] ?? 0);
  const waitingSince = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads the page once when the ticket it was waiting for arrives from the main process
  useEffect(() => {
    if (key !== "reconnecting") {
      waitingSince.current = null;
    } else if (waitingSince.current === null) {
      waitingSince.current = ticketsDelivered;
    } else if (ticketsDelivered > waitingSince.current) {
      waitingSince.current = Number.POSITIVE_INFINITY;
      onReload();
    }
  }, [key, ticketsDelivered, onReload]);

  const permittedToAllow = useAtomValue(allowLoopbackPort.permissionAtom(environmentId));
  const [allowing, setAllowing] = useState<{
    readonly pending: boolean;
    readonly failure: AllowedPortFailure | null;
  }>({ pending: false, failure: null });
  const allowPort = () => {
    if (port === null) return;
    setAllowing({ pending: true, failure: null });
    void allowLoopbackGatewayPort(environmentId, port).then((outcome) => {
      setAllowing({ pending: false, failure: outcome.ok ? null : outcome.failure });
      if (outcome.ok) onReload();
    });
  };

  if (key === null) return null;
  const copy = describeGatewayCard(key, { environment: environmentLabel, port }, t);
  const action =
    gatewayCardOffersAllow(key) && permittedToAllow && port !== null && !held && !startFailed
      ? {
          label: t("Allow forwarding localhost:{port}", { port }),
          onAction: allowPort,
          pending: allowing.pending,
          note: t(
            "From then on, any service on this port is forwarded. You can remove it in Settings → Browser.",
          ),
          error: allowing.failure === null ? null : describeAllowPortFailure(allowing.failure, t),
        }
      : undefined;
  return (
    <div className="absolute inset-0 z-10 bg-background">
      <PreviewUnreachable
        url={url}
        code={0}
        description={held || startFailed ? key : (denial?.code ?? key)}
        onReload={
          startFailed
            ? () => requestGatewayRetry(environmentId)
            : () => {
                setAllowing({ pending: false, failure: null });
                onReload();
              }
        }
        gateway={
          startFailed
            ? { ...copy, reloadLabel: t("Retry") }
            : action === undefined
              ? copy
              : { ...copy, action }
        }
        {...(key === "waiting" || key === "start-failed"
          ? {
              move: {
                label: t("Stop forwarding and use this computer's localhost"),
                onMove: () => setLoopbackForwardingDisabled(environmentId, true),
              },
            }
          : move !== undefined && gatewayCardOffersMove(key)
            ? { move }
            : {})}
      />
    </div>
  );
}
