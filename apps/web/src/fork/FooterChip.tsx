import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import type { FooterLimitSeverity } from "./footerLimits.logic";
import type { FooterDensity } from "./footerDensity.logic";

export const FOOTER_TONE_CLASS: Record<FooterLimitSeverity, string> = {
  ok: "",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
};

/**
 * One status chip in the sidebar footer: a small muted button whose label shrinks with the room
 * left and whose details open in a panel. The tone colors the text only, never the button.
 */
export function FooterChip(props: {
  readonly icon: ReactNode;
  readonly density: FooterDensity;
  readonly fullLabel: ReactNode;
  readonly compactLabel: ReactNode;
  readonly tone?: FooterLimitSeverity;
  readonly ariaLabel: string;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const { icon, density, fullLabel, compactLabel, tone = "ok", ariaLabel, children } = props;
  return (
    <Popover
      {...(props.open === undefined ? {} : { open: props.open })}
      {...(props.onOpenChange === undefined
        ? {}
        : { onOpenChange: (next: boolean) => props.onOpenChange?.(next) })}
    >
      <PopoverTrigger
        openOnHover
        delay={300}
        closeDelay={150}
        render={<Button aria-label={ariaLabel} size="micro" variant="ghost-muted" />}
      >
        <span className={FOOTER_TONE_CLASS[tone]}>{icon}</span>
        {density === "icon" ? null : (
          <span
            className={
              density === "full" ? "tabular-nums" : `tabular-nums ${FOOTER_TONE_CLASS[tone]}`
            }
          >
            {density === "full" ? fullLabel : compactLabel}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" padding="compact" width="md">
        {children}
      </PopoverPopup>
    </Popover>
  );
}

/** Title row of a chip panel; names the machine when more than one environment is connected. */
export function FooterPanelHeader(props: {
  readonly title: string;
  readonly machineLabel: string | null;
}) {
  return (
    <div className="flex flex-col gap-0.5 pb-1.5">
      <span className="font-medium text-foreground text-xs">{props.title}</span>
      {props.machineLabel === null ? null : (
        <span className="truncate text-2xs text-muted-foreground">{props.machineLabel}</span>
      )}
    </div>
  );
}
