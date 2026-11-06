// fork: the mark beside the address bar for a tab whose localhost is forwarded from a remote
// environment, and the way to turn that off and back on (research/remote-loopback-forwarding.md
// 7.1, 10). It stays, grey, after forwarding is stopped, so the way back is always where it was.
import { isLoopbackGatewayHost } from "@t3tools/shared/forkLoopbackGateway/hosts";
import { ArrowLeftRight } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useT } from "~/hooks/useT";
import { cn } from "~/lib/utils";

import { setLoopbackForwardingDisabled } from "./disabledStore";
import type { LoopbackGatewayState } from "./gatewayState";
import type { LoopbackGatewayTabProps } from "./LoopbackGatewayCard";
import { useLoopbackGatewayState } from "./useLoopbackGatewayState";

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** What the mark shows for a tab at `url`: forwarding, stopped by the user, or nothing. */
export const badgeModeFor = (
  state: LoopbackGatewayState["state"],
  url: string,
): "forwarding" | "stopped" | null => {
  const host = hostOf(url);
  if (host === null || !isLoopbackGatewayHost(host)) return null;
  if (state === "active") return "forwarding";
  return state === "disabled-by-user" ? "stopped" : null;
};

export function LoopbackGatewayBadge(
  props: Pick<LoopbackGatewayTabProps, "environmentId" | "environmentLabel" | "url" | "move">,
) {
  const { environmentId, environmentLabel: environment, url, move } = props;
  const t = useT();
  const { state } = useLoopbackGatewayState(environmentId);
  const mode = badgeModeFor(state.state, url);
  if (mode === null) return null;
  const forwarding = mode === "forwarding";
  const label = forwarding
    ? t("localhost is forwarded to {environment}", { environment })
    : t("localhost forwarding is off. Here, localhost is this computer");

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  aria-label={label}
                  data-loopback-gateway={forwarding ? "forwarding" : "stopped"}
                />
              }
            />
          }
        >
          <ArrowLeftRight className={cn(!forwarding && "text-muted-foreground/50")} />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" sideOffset={6}>
        {forwarding ? (
          <>
            {move ? (
              <MenuItem onClick={move.onMove}>
                {t("Open in {environment}'s browser", { environment })}
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => setLoopbackForwardingDisabled(environmentId, true)}>
              {t("Stop forwarding and use this computer's localhost")}
            </MenuItem>
          </>
        ) : (
          <MenuItem onClick={() => setLoopbackForwardingDisabled(environmentId, false)}>
            {t("Resume forwarding")}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuGroup className="max-w-64">
          <MenuGroupLabel>
            {forwarding
              ? t(
                  "Forwarding applies to all of {environment}'s tabs, not just this one. While it is on, external sites in these tabs connect directly, without the system proxy.",
                  { environment },
                )
              : t("Forwarding applies to all of {environment}'s tabs, not just this one.", {
                  environment,
                })}
          </MenuGroupLabel>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
