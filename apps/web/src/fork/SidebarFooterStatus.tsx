import type { ScopedProjectRef } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { SidebarMenuItem } from "../components/ui/sidebar";
import { observeResize } from "../lib/observeResize";
import {
  type FooterChipSize,
  type FooterDensity,
  resolveFooterDensity,
} from "./footerDensity.logic";
import { useFooterStatusToggle } from "./footerStatusStore";
import { FooterUsageLimits, footerLimitsSize, useFooterLimits } from "./FooterUsageLimits";
import { useFooterScope } from "./useFooterScope";

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
  const scope = useFooterScope(props.scopedProjectRefs);
  const limits = useFooterLimits(limitsOn ? scope.environmentId : null);
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
  if (chips.length === 0) return null;

  const density = resolveFooterDensity(
    available,
    chips.map((chip) => chip.size),
  );
  return (
    <SidebarMenuItem
      className="min-w-0 shrink overflow-hidden"
      data-footer-status
      ref={(item) => {
        const row = item?.parentElement;
        if (!item || !row) return;
        const measure = () =>
          setAvailable(row.getBoundingClientRect().right - item.getBoundingClientRect().left);
        measure();
        return observeResize(
          item.previousElementSibling ? [row, item.previousElementSibling] : [row],
          measure,
        );
      }}
    >
      <div className="flex items-center gap-0.5">
        {chips.map((chip) => (
          <div key={chip.key} className="flex shrink-0">
            {chip.render(density)}
          </div>
        ))}
      </div>
    </SidebarMenuItem>
  );
}
