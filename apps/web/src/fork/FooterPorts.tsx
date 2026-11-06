import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadDisplayTitle } from "@t3tools/client-runtime/operations";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { AppWindowIcon, PlugIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { resolveDiscoveredServerUrl } from "../browser/browserTargetResolver";
import { Button } from "../components/ui/button";
import { PopoverClose } from "../components/ui/popover";
import { openDiscoveredPort } from "../components/preview/openDiscoveredPort";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useT } from "../hooks/useT";
import { readLocalApi } from "../localApi";
import { previewEnvironment } from "../state/preview";
import { useEnvironmentQuery } from "../state/query";
import { useQuietThreadShells } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { FooterChip, FooterPanelHeader } from "./FooterChip";
import { type FooterChipSize, type FooterDensity, footerChipSize } from "./footerDensity.logic";
import { type FooterPortRow, footerPortsLabels, selectProjectServers } from "./footerPorts.logic";
import { useHeldValue } from "./useHeldValue";
import { useWindowVisible } from "./useWindowVisible";

const NO_ROWS: readonly FooterPortRow[] = [];

/**
 * Servers that threads of the shown projects started. Like the resource chip it rides the slow
 * background rate, drops the subscription while the window is hidden, and asks for the live rate
 * only while its panel is open.
 */
export function useFooterPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: readonly ScopedProjectRef[];
  readonly panelOpen: boolean;
}): readonly FooterPortRow[] {
  const visible = useWindowVisible();
  const canRead = useEnvironmentScope(input.environmentId, AuthOrchestrationReadScope);
  const environmentId = input.environmentId !== null && canRead ? input.environmentId : null;
  const subscribed = environmentId !== null && visible;
  const background = useEnvironmentQuery(
    subscribed && !input.panelOpen
      ? previewEnvironment.discoveredServers({ environmentId, input: { cadence: "background" } })
      : null,
  );
  const live = useEnvironmentQuery(
    subscribed && input.panelOpen
      ? previewEnvironment.discoveredServers({ environmentId, input: {} })
      : null,
  );
  const servers = (live.data ?? background.data)?.servers ?? null;
  const threads = useQuietThreadShells();
  const rows = useHeldValue(
    environmentId,
    environmentId === null || servers === null
      ? null
      : selectProjectServers({ servers, threads, environmentId, projectRefs: input.projectRefs }),
  );
  return environmentId === null ? NO_ROWS : (rows ?? NO_ROWS);
}

export function footerPortsSize(rows: readonly FooterPortRow[]): FooterChipSize {
  return footerChipSize(footerPortsLabels(rows));
}

function PortsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly rows: readonly FooterPortRow[];
  readonly machineLabel: string | null;
}) {
  const t = useT();
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const reportFailure = (title: string, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  const open = async (row: FooterPortRow, event: MouseEvent<HTMLElement>) => {
    // Like links: a modified click goes to the system browser.
    if (event.metaKey || event.ctrlKey) {
      await readLocalApi()
        ?.shell.openExternal(
          resolveDiscoveredServerUrl(props.environmentId, row.server.url, { systemBrowser: true }),
        )
        .catch((error: unknown) => reportFailure(t("Unable to open in browser"), error));
      return;
    }
    const result = await openDiscoveredPort({
      threadRef: scopeThreadRef(row.threadRef.environmentId, row.threadRef.threadId),
      port: row.server,
      openPreview,
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(t("Unable to open preview"), squashAtomCommandFailure(result));
    }
  };
  return (
    <>
      <FooterPanelHeader title={t("Servers")} machineLabel={props.machineLabel} />
      <ul className="m-0 flex list-none flex-col p-0">
        {props.rows.map((row) => (
          <li key={row.port}>
            <PopoverClose
              render={
                <Button
                  size="sm-multiline"
                  variant="ghost"
                  className="w-full justify-start"
                  disabled={!canOpen}
                  aria-label={t("Open in preview")}
                  onClick={(event) => void open(row, event)}
                />
              }
            >
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
                <span className="max-w-full truncate text-xs font-medium">
                  localhost:{row.port}
                  {row.processName ? (
                    <span className="font-normal text-muted-foreground"> · {row.processName}</span>
                  ) : null}
                </span>
                <span className="max-w-full truncate text-2xs font-normal text-muted-foreground">
                  {threadDisplayTitle(row.threadTitle, t)}
                  {" · "}
                  {row.worktree ?? t("Main checkout")}
                </span>
              </span>
              <AppWindowIcon aria-hidden className="shrink-0 text-muted-foreground" />
            </PopoverClose>
          </li>
        ))}
      </ul>
    </>
  );
}

export function FooterPorts(props: {
  readonly environmentId: EnvironmentId;
  readonly rows: readonly FooterPortRow[];
  readonly density: FooterDensity;
  readonly machineLabel: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const labels = footerPortsLabels(props.rows);
  return (
    <FooterChip
      icon={<PlugIcon />}
      density={props.density}
      ariaLabel={t("Servers")}
      fullLabel={labels.full}
      compactLabel={labels.compact}
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <PortsPanel
        environmentId={props.environmentId}
        rows={props.rows}
        machineLabel={props.machineLabel}
      />
    </FooterChip>
  );
}
