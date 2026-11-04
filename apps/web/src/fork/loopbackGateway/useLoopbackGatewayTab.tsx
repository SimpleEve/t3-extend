// fork: the loopback gateway's two pieces of a preview tab, for PreviewView to place: the mark in
// the address bar and the card over the page.
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { useT } from "~/hooks/useT";
import { useEnvironment } from "~/state/environments";

import { getLoopbackGatewayBridge } from "./bridge";
import { LoopbackGatewayBadge } from "./LoopbackGatewayBadge";
import { LoopbackGatewayCard } from "./LoopbackGatewayCard";

export function useLoopbackGatewayTab(input: {
  readonly threadRef: ScopedThreadRef;
  readonly runtimeTabId: string | null;
  readonly url: string;
  readonly loadFailed: boolean;
  /** The tab is drawn by the server's own browser, where localhost already means that server. */
  readonly serverOwnsRendering: boolean;
  readonly onReload: () => void;
  /** Opens the tab in the environment's own browser; absent when that is not possible. */
  readonly onOpenInEnvironment: (() => void) | undefined;
}): { readonly badge: ReactNode; readonly card: ReactNode } {
  const t = useT();
  const { environmentId } = input.threadRef;
  const environmentLabel = useEnvironment(environmentId)?.label ?? t("the environment");
  const { runtimeTabId, url, loadFailed, onReload, onOpenInEnvironment } = input;
  const hasGateway = previewBridge !== null && getLoopbackGatewayBridge() !== undefined;
  if (!hasGateway || runtimeTabId === null || input.serverOwnsRendering) {
    return { badge: null, card: null };
  }
  const move =
    onOpenInEnvironment === undefined
      ? undefined
      : {
          label: t("Open in {environment}'s browser", { environment: environmentLabel }),
          onMove: onOpenInEnvironment,
        };
  const props = { environmentId, environmentLabel, runtimeTabId, url, loadFailed, onReload, move };
  return { badge: <LoopbackGatewayBadge {...props} />, card: <LoopbackGatewayCard {...props} /> };
}
