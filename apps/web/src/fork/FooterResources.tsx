import { AuthDiagnosticsReadScope, type EnvironmentId } from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { PopoverClose } from "../components/ui/popover";
import { useT } from "../hooks/useT";
import { formatBytes } from "../lib/formatBytes";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { FooterChip, FooterPanelHeader } from "./FooterChip";
import { type FooterChipSize, type FooterDensity, footerChipSize } from "./footerDensity.logic";
import {
  type FooterResourceRow,
  type FooterResourceSummary,
  footerResourcesLabels,
  formatCpuPercent,
  summarizeResources,
} from "./footerResources.logic";
import { useHeldValue } from "./useHeldValue";
import { useWindowVisible } from "./useWindowVisible";

/**
 * CPU and memory of the shown environment, or null while it is unreadable with this connection or
 * has not reported yet. The chip rides the server's slow background rate and holds no subscription
 * while the window is hidden; only while its panel is open does it also ask for the live rate.
 */
export function useFooterResources(environmentId: EnvironmentId | null, panelOpen: boolean) {
  const visible = useWindowVisible();
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const activeEnvironmentId = environmentId !== null && canRead ? environmentId : null;
  const subscribed = activeEnvironmentId !== null && visible;
  // One stream at a time: while the panel is open the live one covers the chip as well.
  const background = useEnvironmentQuery(
    subscribed && !panelOpen
      ? serverEnvironment.resourceTelemetry({
          environmentId: activeEnvironmentId,
          input: { cadence: "background" },
        })
      : null,
  );
  const live = useEnvironmentQuery(
    subscribed && panelOpen
      ? serverEnvironment.resourceTelemetry({ environmentId: activeEnvironmentId, input: {} })
      : null,
  );
  const data = live.data ?? background.data;
  const summary = useHeldValue(
    activeEnvironmentId,
    data === null ? null : summarizeResources(data),
  );
  return activeEnvironmentId === null ? null : summary;
}

export function footerResourcesSize(summary: FooterResourceSummary): FooterChipSize {
  return footerChipSize(footerResourcesLabels(summary));
}

function ResourceRowView(props: { readonly row: FooterResourceRow }) {
  const { row } = props;
  const t = useT();
  const name =
    row.kind === "agent"
      ? (row.label ?? "")
      : row.kind === "terminal"
        ? t("Terminal")
        : row.kind === "t3"
          ? FORK.appBaseName
          : t("Other");
  return (
    <div className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground">
      <span className="truncate">{name}</span>
      <span className="shrink-0 tabular-nums">
        {row.processCount === 1
          ? t("{count} process", { count: row.processCount })
          : t("{count} processes", { count: row.processCount })}
        {" · "}
        {formatCpuPercent(row.cpuPercent)}
        {" · "}
        {formatBytes(row.rssBytes)}
      </span>
    </div>
  );
}

function ResourcesPanel(props: {
  readonly summary: FooterResourceSummary;
  readonly machineLabel: string | null;
}) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <>
      <FooterPanelHeader title={t("Resource usage")} machineLabel={props.machineLabel} />
      <div className="flex flex-col gap-1">
        {props.summary.rows.map((row) => (
          <ResourceRowView key={row.id} row={row} />
        ))}
      </div>
      <div className="flex justify-end pt-1.5">
        <PopoverClose
          render={
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void navigate({ to: "/settings/diagnostics" })}
            />
          }
        >
          {t("Diagnostics")}
        </PopoverClose>
      </div>
    </>
  );
}

export function FooterResources(props: {
  readonly summary: FooterResourceSummary;
  readonly density: FooterDensity;
  readonly machineLabel: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const labels = footerResourcesLabels(props.summary);
  return (
    <FooterChip
      icon={<CpuIcon />}
      density={props.density}
      ariaLabel={t("Resource usage")}
      fullLabel={labels.full}
      compactLabel={labels.compact}
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <ResourcesPanel summary={props.summary} machineLabel={props.machineLabel} />
    </FooterChip>
  );
}
