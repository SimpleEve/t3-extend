import type { ScopedProjectRef } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { SidebarMenuItem } from "../components/ui/sidebar";
import { observeResize } from "../lib/observeResize";
import {
  type FooterChipSize,
  type FooterDensity,
  maxIconChips,
  resolveFooterDensity,
} from "./footerDensity.logic";
import { useFooterStatusToggle } from "./footerStatusStore";
import { FooterPorts, footerPortsSize, useFooterPorts } from "./FooterPorts";
import { FooterResources, footerResourcesSize, useFooterResources } from "./FooterResources";
import { FooterUsageLimits, footerLimitsSize, useFooterLimits } from "./FooterUsageLimits";
import { useFooterScope } from "./useFooterScope";

// The sidebar footer row's `gap-1`.
const ROW_GAP_PX = 4;

interface FooterChipSpec {
  readonly key: string;
  readonly size: FooterChipSize;
  readonly render: (density: FooterDensity) => ReactNode;
}

/**
 * The status chips on the sidebar's bottom row, after the Settings, PR and Usage icons. The
 * wrapper takes its natural width and may shrink, so it can never push those icons or the update
 * pill out; the density follows the room left to its right.
 */
export function SidebarFooterStatus(props: {
  readonly scopedProjectRefs: readonly ScopedProjectRef[];
}) {
  const limitsOn = useFooterStatusToggle("limits");
  const resourcesOn = useFooterStatusToggle("resources");
  const portsOn = useFooterStatusToggle("ports");
  const scope = useFooterScope(props.scopedProjectRefs);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [portsOpen, setPortsOpen] = useState(false);
  const limits = useFooterLimits(limitsOn ? scope.environmentId : null);
  const resources = useFooterResources(resourcesOn ? scope.environmentId : null, resourcesOpen);
  const ports = useFooterPorts({
    environmentId: portsOn ? scope.environmentId : null,
    projectRefs: scope.projectRefs,
    panelOpen: portsOpen,
  });
  const [available, setAvailable] = useState(Number.POSITIVE_INFINITY);

  const chips: FooterChipSpec[] = [];
  if (limits.length > 0) {
    chips.push({
      key: "limits",
      size: footerLimitsSize(limits),
      render: (density) => (
        <FooterUsageLimits entries={limits} density={density} machineLabel={scope.machineLabel} />
      ),
    });
  }
  if (resources !== null) {
    chips.push({
      key: "resources",
      size: footerResourcesSize(resources),
      render: (density) => (
        <FooterResources
          summary={resources}
          density={density}
          machineLabel={scope.machineLabel}
          open={resourcesOpen}
          onOpenChange={setResourcesOpen}
        />
      ),
    });
  }
  if (ports.length > 0 && scope.environmentId !== null) {
    const environmentId = scope.environmentId;
    chips.push({
      key: "ports",
      size: footerPortsSize(ports),
      render: (density) => (
        <FooterPorts
          environmentId={environmentId}
          rows={ports}
          density={density}
          machineLabel={scope.machineLabel}
          open={portsOpen}
          onOpenChange={setPortsOpen}
        />
      ),
    });
  }
  if (chips.length === 0) return null;

  const density = resolveFooterDensity(
    available,
    chips.map((chip) => chip.size),
  );
  // Where even the icons do not all fit, the last chips drop out whole instead of being clipped.
  const shown = density === "icon" ? chips.slice(0, maxIconChips(available)) : chips;
  return (
    <SidebarMenuItem
      className="min-w-0 shrink overflow-hidden"
      data-footer-status
      ref={(item) => {
        const row = item?.parentElement;
        if (!item || !row) return;
        // The update pill after the chips is pinned to the right edge and never shrinks.
        const after = item.nextElementSibling;
        const measure = () => {
          const next = item.nextElementSibling;
          const limit = next
            ? next.getBoundingClientRect().left - ROW_GAP_PX
            : row.getBoundingClientRect().right;
          setAvailable(limit - item.getBoundingClientRect().left);
        };
        measure();
        return observeResize(
          [row, item.previousElementSibling, after].filter((element) => element !== null),
          measure,
        );
      }}
    >
      <div className="flex items-center gap-0.5">
        {shown.map((chip) => (
          <div key={chip.key} className="flex shrink-0">
            {chip.render(density)}
          </div>
        ))}
      </div>
    </SidebarMenuItem>
  );
}
