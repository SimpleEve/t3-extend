import type { ScopedProjectRef } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { observeResize } from "../lib/observeResize";
import {
  type FooterChipSize,
  type FooterDensity,
  resolveFooterLayout,
} from "./footerDensity.logic";
import { useFooterStatusToggle } from "./footerStatusStore";
import { FooterPorts, footerPortsSize, useFooterPorts } from "./FooterPorts";
import { FooterResources, footerResourcesSize, useFooterResources } from "./FooterResources";
import { FooterUsageLimits, footerLimitsSize, useFooterLimits } from "./FooterUsageLimits";
import { useFooterScope } from "./useFooterScope";

// Lines the first chip's icon up with the Settings icon below it (the `ps-1` on the row).
const ROW_INSET_PX = 4;

interface FooterChipSpec {
  readonly key: string;
  readonly size: FooterChipSize;
  readonly render: (density: FooterDensity) => ReactNode;
}

/**
 * The status chips, on a row of their own right above the sidebar's icon row. Chips are listed in
 * priority order (limits, resources, ports); `resolveFooterLayout` shares the row's width by that
 * order. The row is not rendered at all while no chip is shown.
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

  const layout = resolveFooterLayout(
    available,
    chips.map((chip) => chip.size),
  );
  return (
    <div
      // Hidden, not removed, when nothing fits: the footer's gap must not reserve an empty row,
      // and the width still has to be measured to bring the chips back when the sidebar widens.
      className={layout.length === 0 ? "hidden" : "flex min-w-0 items-center gap-0.5 ps-1"}
      data-footer-status
      ref={(row) => {
        const footer = row?.parentElement;
        if (!row || !footer) return;
        const measure = () => {
          const style = getComputedStyle(footer);
          setAvailable(
            footer.clientWidth -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight) -
              ROW_INSET_PX,
          );
        };
        measure();
        return observeResize(footer, measure);
      }}
    >
      {layout.map((density, index) => {
        const chip = chips[index]!;
        return (
          <div key={chip.key} className="flex shrink-0">
            {chip.render(density)}
          </div>
        );
      })}
    </div>
  );
}
