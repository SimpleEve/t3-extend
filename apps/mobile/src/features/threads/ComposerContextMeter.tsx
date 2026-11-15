import type { CompactNowBlocker, ContextMeter } from "@t3tools/client-runtime/state/context-window";
import {
  formatTokensPerSecond,
  formatTurnSeconds,
  type TurnSpeed,
} from "@t3tools/client-runtime/state/turn-speed";
import { Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useT } from "../../hooks/useT";
import { cn } from "../../lib/cn";
import { withUniwind } from "uniwind";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function toneTextClassName(tone: ContextMeter["tone"]) {
  return tone === "error"
    ? "text-danger-foreground"
    : tone === "warning"
      ? "text-warning-foreground"
      : "text-foreground-muted";
}

const ThemedSvg = withUniwind(Svg);

function ContextRing(props: { size: number; percent: number; tone: ContextMeter["tone"] }) {
  return (
    <ThemedSvg
      width={props.size}
      height={props.size}
      viewBox="0 0 16 16"
      colorClassName={
        props.tone === "error"
          ? "accent-danger-foreground"
          : props.tone === "warning"
            ? "accent-warning-foreground"
            : "accent-icon-muted"
      }
    >
      <Circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={2}
        fill="none"
      />
      {props.percent > 0 ? (
        <Circle
          cx="8"
          cy="8"
          r={RING_RADIUS}
          stroke="currentColor"
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(RING_CIRCUMFERENCE * props.percent) / 100} ${RING_CIRCUMFERENCE}`}
          rotation={-90}
          origin="8, 8"
        />
      ) : null}
    </ThemedSvg>
  );
}

/** The ring in the composer toolbar; the percentage shows when the toolbar has room. */
export function ContextMeterControl(props: {
  readonly meter: ContextMeter;
  readonly size: "regular" | "large";
  readonly showPercent: boolean;
  readonly open: boolean;
  readonly onPress: () => void;
}) {
  const t = useT();
  return (
    <ComposerInlineControl
      size={props.size}
      label={`${props.meter.percent}%`}
      accessibilityLabel={`${t("Context usage")} ${props.meter.percent}%`}
      renderIcon={(size) => (
        <ContextRing size={size} percent={props.meter.percent} tone={props.meter.tone} />
      )}
      iconOnly={!props.showPercent}
      showChevron={false}
      selected={props.open}
      onPress={props.onPress}
    />
  );
}

/** The last turn's speed, where the toolbar has room; the card always carries it too. */
export function TurnSpeedControl(props: {
  readonly speed: TurnSpeed;
  readonly size: "regular" | "large";
  readonly onPress: () => void;
}) {
  const t = useT();
  return (
    <ComposerInlineControl
      size={props.size}
      label={t("~{speed} tok/s", { speed: formatTokensPerSecond(props.speed.tokensPerSecond) })}
      showChevron={false}
      onPress={props.onPress}
    />
  );
}

function useBlockerLabel() {
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

/** Usage, auto-compact point, last-turn speed and Compact now, in the card style of the usage limits. */
export function ContextMeterCard(props: {
  readonly meter: ContextMeter;
  readonly speed: TurnSpeed | null;
  readonly compactBlocker: CompactNowBlocker | null;
  readonly onCompact: () => void;
  readonly onClose: () => void;
}) {
  const { meter, speed, compactBlocker } = props;
  const t = useT();
  const blockerLabel = useBlockerLabel();
  return (
    <View className="mb-2 gap-2 rounded-[20px] border-continuous bg-card px-4 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
          {t("Context usage")}
        </Text>
        <Text className={cn("text-base font-t3-medium", toneTextClassName(meter.tone))}>
          {meter.percent}%
        </Text>
        <Pressable
          accessibilityLabel={t("Close")}
          accessibilityRole="button"
          hitSlop={12}
          onPress={props.onClose}
          className="-me-1 p-1 active:opacity-60"
        >
          <SymbolView
            name="xmark"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      </View>
      <View className="gap-0.5">
        <Text className="text-sm text-foreground-muted">
          {t("{used} / {max} tokens", {
            used: meter.usedTokens.toLocaleString("en-US"),
            max: meter.maxTokens.toLocaleString("en-US"),
          })}
        </Text>
        {meter.autoCompactPercent !== null ? (
          <Text className="text-sm text-foreground-muted">
            {t("Compacts automatically at {percent}%", { percent: meter.autoCompactPercent })}
          </Text>
        ) : null}
        {speed !== null ? (
          <Text className="text-sm text-foreground-muted">
            {speed.firstTokenMs !== null
              ? t("Last turn ~{speed} tok/s · first token {latency}", {
                  speed: formatTokensPerSecond(speed.tokensPerSecond),
                  latency: formatTurnSeconds(speed.firstTokenMs),
                })
              : t("Last turn ~{speed} tok/s", {
                  speed: formatTokensPerSecond(speed.tokensPerSecond),
                })}
          </Text>
        ) : null}
        {speed !== null && speed.turnMs !== null ? (
          <Text className="text-sm text-foreground-muted">
            {`${t("Total time")} ${formatTurnSeconds(speed.turnMs)} · ${t("Output")} ${t(
              "{tokens} tokens",
              { tokens: speed.outputTokens.toLocaleString("en-US") },
            )}`}
          </Text>
        ) : null}
      </View>
      <Button
        label={t("Compact now")}
        size="compact"
        disabled={compactBlocker !== null}
        onPress={props.onCompact}
      />
      {compactBlocker !== null ? (
        <Text className="text-xs text-foreground-muted">{blockerLabel(compactBlocker)}</Text>
      ) : null}
    </View>
  );
}
