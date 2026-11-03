import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { PopoverClose } from "../components/ui/popover";
import { useT } from "../hooks/useT";
import { formatBytes } from "../lib/formatBytes";
import { useResourceTelemetry } from "../lib/resourceTelemetryState";
import { FooterChip, FooterPanelHeader } from "./FooterChip";
import type { FooterChipSize, FooterDensity } from "./footerDensity.logic";
import {
  type FooterResourceGroupKey,
  type FooterResourceSummary,
  footerResourcesLabels,
  formatCpuPercent,
  summarizeResources,
} from "./footerResources.logic";

/**
 * Live resource use of the shown environment, or null while it is off, unreadable with this
 * connection, or has not reported yet. The live subscription samples the process table, so it
 * is only open while the chip is wanted; the background policy slows it when the window is idle.
 */
export function useFooterResources(environmentId: EnvironmentId | null) {
  const { data } = useResourceTelemetry(environmentId);
  return data === null ? null : summarizeResources(data);
}

export function footerResourcesSize(summary: FooterResourceSummary): FooterChipSize {
  const labels = footerResourcesLabels(summary);
  return { fullChars: labels.full.length, compactChars: labels.compact.length };
}

const GROUP_LABEL_KEYS: Record<FooterResourceGroupKey, string> = {
  backend: "Backend",
  electron: "Desktop app",
  monitor: "Resource monitor",
};

function ResourcesPanel(props: {
  readonly summary: FooterResourceSummary;
  readonly machineLabel: string | null;
}) {
  const { summary, machineLabel } = props;
  const t = useT();
  const navigate = useNavigate();
  return (
    <>
      <FooterPanelHeader title={t("Resource usage")} machineLabel={machineLabel} />
      <div className="flex flex-col gap-1">
        {summary.groups.map((group) => (
          <div
            key={group.key}
            className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground"
          >
            <span className="truncate">{t(GROUP_LABEL_KEYS[group.key])}</span>
            <span className="shrink-0 tabular-nums">
              {formatCpuPercent(group.cpuPercent)} · {formatBytes(group.rssBytes)}
            </span>
          </div>
        ))}
      </div>
      {summary.topProcesses.length === 0 ? null : (
        <div className="flex flex-col gap-1 pt-2">
          <span className="font-medium text-foreground text-xs">{t("Top processes")}</span>
          {summary.topProcesses.map((process) => (
            <div
              key={`${process.identity.pid}:${process.identity.startTimeMs}`}
              className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground"
            >
              <span className="truncate">{process.name}</span>
              <span className="shrink-0 tabular-nums">{formatBytes(process.residentBytes)}</span>
            </div>
          ))}
        </div>
      )}
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
}) {
  const { summary, density, machineLabel } = props;
  const t = useT();
  const labels = footerResourcesLabels(summary);
  return (
    <FooterChip
      icon={<CpuIcon />}
      density={density}
      ariaLabel={t("Resource usage")}
      fullLabel={labels.full}
      compactLabel={labels.compact}
    >
      <ResourcesPanel summary={summary} machineLabel={machineLabel} />
    </FooterChip>
  );
}
