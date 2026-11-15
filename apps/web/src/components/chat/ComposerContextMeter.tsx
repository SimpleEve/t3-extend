import type { CompactNowBlocker, ContextMeter } from "@t3tools/client-runtime/state/context-window";
import {
  formatTokensPerSecond,
  formatTurnSeconds,
  type TurnSpeed,
} from "@t3tools/client-runtime/state/turn-speed";
import { memo, useState } from "react";

import { useT } from "~/hooks/useT";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ContextRing(props: { percent: number; tone: ContextMeter["tone"] }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" strokeWidth={2} aria-hidden="true">
      <circle cx="8" cy="8" r={RING_RADIUS} className="stroke-current opacity-25" />
      {props.percent > 0 ? (
        <circle
          cx="8"
          cy="8"
          r={RING_RADIUS}
          transform="rotate(-90 8 8)"
          strokeLinecap="round"
          strokeDasharray={`${(RING_CIRCUMFERENCE * props.percent) / 100} ${RING_CIRCUMFERENCE}`}
          className={cn(
            props.tone === "error"
              ? "stroke-error"
              : props.tone === "warning"
                ? "stroke-warning"
                : "stroke-current",
          )}
        />
      ) : null}
    </svg>
  );
}

function toneTextClassName(tone: ContextMeter["tone"]) {
  return tone === "error"
    ? "text-error-foreground"
    : tone === "warning"
      ? "text-warning-foreground"
      : undefined;
}

function useCompactBlockerLabel() {
  const t = useT();
  return (blocker: CompactNowBlocker) => {
    switch (blocker) {
      case "permission":
        return t("You don't have permission to operate this thread.");
      case "provider":
        return t("This provider doesn't support /compact.");
      case "empty":
        return t("There is nothing to compact yet.");
      case "working":
        return t("Wait for the current turn to finish.");
      case "pending":
        return t("Answer the pending request first.");
      case "other":
        return t("Compaction isn't available right now.");
    }
  };
}

function ContextMeterDetails(props: {
  meter: ContextMeter;
  speed: TurnSpeed | null;
  compactBlocker: CompactNowBlocker | null;
  onCompact: () => void;
}) {
  const { meter, speed, compactBlocker, onCompact } = props;
  const t = useT();
  const blockerLabel = useCompactBlockerLabel();
  const compactButton = (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={compactBlocker !== null}
      onClick={onCompact}
    >
      {t("Compact now")}
    </Button>
  );
  return (
    <div className="flex w-full flex-col gap-2 text-xs" data-context-meter-details="">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-foreground">{t("Context usage")}</span>
        <span className={cn("font-medium tabular-nums", toneTextClassName(meter.tone))}>
          {meter.percent}%
        </span>
      </div>
      <div className="flex flex-col gap-0.5 text-muted-foreground">
        <span className="tabular-nums">
          {t("{used} / {max} tokens", {
            used: meter.usedTokens.toLocaleString("en-US"),
            max: meter.maxTokens.toLocaleString("en-US"),
          })}
        </span>
        {meter.autoCompactPercent !== null ? (
          <span>
            {t("Compacts automatically at {percent}%", { percent: meter.autoCompactPercent })}
          </span>
        ) : null}
        {speed !== null ? (
          <span className="tabular-nums">
            {speed.firstTokenMs !== null
              ? t("Last turn ~{speed} tok/s · first token {latency}", {
                  speed: formatTokensPerSecond(speed.tokensPerSecond),
                  latency: formatTurnSeconds(speed.firstTokenMs),
                })
              : t("Last turn ~{speed} tok/s", {
                  speed: formatTokensPerSecond(speed.tokensPerSecond),
                })}
          </span>
        ) : null}
      </div>
      {compactBlocker !== null ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex self-start" />}>
            {compactButton}
          </TooltipTrigger>
          <TooltipPopup>{blockerLabel(compactBlocker)}</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="inline-flex self-start">{compactButton}</span>
      )}
    </div>
  );
}

function TurnSpeedDetails(props: { speed: TurnSpeed }) {
  const { speed } = props;
  const t = useT();
  return (
    <div className="flex w-full flex-col gap-2 text-xs" data-turn-speed-details="">
      <span className="font-medium text-foreground">{t("Last turn")}</span>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 tabular-nums">
        {speed.turnMs !== null ? (
          <>
            <span className="text-muted-foreground">{t("Total time")}</span>
            <span className="text-end">{formatTurnSeconds(speed.turnMs)}</span>
          </>
        ) : null}
        {speed.firstTokenMs !== null ? (
          <>
            <span className="text-muted-foreground">{t("First token")}</span>
            <span className="text-end">{formatTurnSeconds(speed.firstTokenMs)}</span>
          </>
        ) : null}
        <span className="text-muted-foreground">{t("Output")}</span>
        <span className="text-end">
          {t("{tokens} tokens", { tokens: speed.outputTokens.toLocaleString("en-US") })}
        </span>
      </div>
      <span className="text-muted-foreground">
        {t("Approximate: counts the time spent writing, not tool calls.")}
      </span>
    </div>
  );
}

/**
 * Context usage ring and last-turn speed in the composer footer. Each renders only with data. The
 * speed is fixed per finished turn, so nothing here changes while a reply streams.
 */
export const ComposerContextMeter = memo(function ComposerContextMeter(props: {
  meter: ContextMeter | null;
  speed: TurnSpeed | null;
  /** Narrow footer: the ring alone, without its percentage or the speed label. */
  compact: boolean;
  compactBlocker: CompactNowBlocker | null;
  onCompact: () => void;
}) {
  const { meter, speed, compact, compactBlocker, onCompact } = props;
  const t = useT();
  const [meterOpen, setMeterOpen] = useState(false);
  if (meter === null && speed === null) return null;
  return (
    <div
      data-chat-composer-context-meter=""
      className="flex shrink-0 items-center gap-0.5 text-muted-foreground"
    >
      {meter !== null ? (
        <Popover open={meterOpen} onOpenChange={setMeterOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                aria-label={`${t("Context usage")} ${meter.percent}%`}
                data-context-meter-trigger=""
              />
            }
          >
            <ContextRing percent={meter.percent} tone={meter.tone} />
            {compact ? null : (
              <span className={cn("tabular-nums", toneTextClassName(meter.tone))}>
                {meter.percent}%
              </span>
            )}
          </PopoverTrigger>
          <PopoverPopup
            side="top"
            align="end"
            width="sm"
            padding="compact"
            variant="solid"
            initialFocus={false}
          >
            <ContextMeterDetails
              meter={meter}
              speed={speed}
              compactBlocker={compactBlocker}
              onCompact={() => {
                setMeterOpen(false);
                onCompact();
              }}
            />
          </PopoverPopup>
        </Popover>
      ) : null}
      {speed !== null && !compact ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button type="button" size="xs" variant="ghost-muted" data-turn-speed-trigger="" />
            }
          >
            <span className="tabular-nums">
              {t("~{speed} tok/s", { speed: formatTokensPerSecond(speed.tokensPerSecond) })}
            </span>
          </PopoverTrigger>
          <PopoverPopup
            side="top"
            align="end"
            width="sm"
            padding="compact"
            variant="solid"
            initialFocus={false}
          >
            <TurnSpeedDetails speed={speed} />
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
});
