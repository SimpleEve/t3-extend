import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { formatDuration, usageWindowLabel } from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { GaugeIcon } from "lucide-react";

import { PROVIDER_PRESENTATION } from "../components/usage/usageProviders";
import { Button } from "../components/ui/button";
import { PopoverClose } from "../components/ui/popover";
import { useNowMinute } from "../hooks/useNowMinute";
import { useT } from "../hooks/useT";
import { serverEnvironment } from "../state/server";
import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../timestampFormat";
import { usePrimarySettings } from "../hooks/useSettings";
import { FOOTER_TONE_CLASS, FooterChip, FooterPanelHeader } from "./FooterChip";
import type { FooterChipSize, FooterDensity } from "./footerDensity.logic";
import { collectFooterLimits, type FooterLimitEntry, mostUrgentLimit } from "./footerLimits.logic";

function providerLabel(provider: ServerProvider): string {
  if (provider.displayName) return provider.displayName;
  const presentation = Object.values(PROVIDER_PRESENTATION).find(
    (entry) => entry.driverKind === provider.driver,
  );
  return presentation?.label ?? provider.driver;
}

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const NO_PROVIDERS_ATOM = Atom.make<ReadonlyArray<ServerProvider> | null>(null);

/** Usable subscription windows of the shown environment, one entry per provider. */
export function useFooterLimits(environmentId: EnvironmentId | null): readonly FooterLimitEntry[] {
  const providers = useAtomValue(
    environmentId === null
      ? NO_PROVIDERS_ATOM
      : serverEnvironment.providersValueAtom(environmentId),
  );
  return collectFooterLimits(providers ?? EMPTY_PROVIDERS, providerLabel);
}

export function footerLimitsSize(entries: readonly FooterLimitEntry[]): FooterChipSize {
  return {
    fullChars: entries.reduce((sum, entry) => sum + entry.label.length + 5, 0) + entries.length - 1,
    compactChars: 3,
  };
}

function LimitsPanel(props: {
  readonly entries: readonly FooterLimitEntry[];
  readonly machineLabel: string | null;
}) {
  const { entries, machineLabel } = props;
  const t = useT();
  const navigate = useNavigate();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  // Only mounted while the panel is open, so the minute clock runs only then.
  const now = Date.parse(useNowMinute());
  return (
    <>
      <FooterPanelHeader title={t("Subscription limits")} machineLabel={machineLabel} />
      <div className="flex flex-col gap-2">
        {entries.map((entry) => (
          <div key={entry.instanceId} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium text-foreground text-xs">{entry.label}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {t("Updated {time}", { time: formatRelativeTimeLabel(entry.checkedAt, now) })}
              </span>
            </div>
            {entry.windows.map((window) => {
              const remaining = Math.round(100 - window.usedPercent);
              const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
              return (
                <div key={window.id} className="flex flex-col text-2xs text-muted-foreground">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{usageWindowLabel(window.label, t)}</span>
                    <span
                      className={`shrink-0 tabular-nums ${
                        window === entry.tightest ? FOOTER_TONE_CLASS[entry.severity] : ""
                      }`}
                    >
                      {t("{remaining}% left", { remaining })}
                    </span>
                  </div>
                  {window.resetsAt ? (
                    <span className="truncate tabular-nums">
                      {resetsAt > now
                        ? t("Resets in {duration} · {time}", {
                            duration: formatDuration(resetsAt - now, t),
                            time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now),
                          })
                        : t("resets now")}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex justify-end pt-1.5">
        <PopoverClose
          render={
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void navigate({ to: "/usage" })}
            />
          }
        >
          {t("Usage details")}
        </PopoverClose>
      </div>
    </>
  );
}

export function FooterUsageLimits(props: {
  readonly entries: readonly FooterLimitEntry[];
  readonly density: FooterDensity;
  readonly machineLabel: string | null;
}) {
  const { entries, density, machineLabel } = props;
  const t = useT();
  const urgent = mostUrgentLimit(entries);
  if (urgent === null) return null;
  return (
    <FooterChip
      icon={<GaugeIcon />}
      density={density}
      tone={urgent.severity}
      ariaLabel={t("Subscription limits")}
      fullLabel={entries.map((entry, index) => (
        <span key={entry.instanceId}>
          {index === 0 ? "" : " · "}
          <span className={FOOTER_TONE_CLASS[entry.severity]}>
            {entry.label} {entry.remaining}%
          </span>
        </span>
      ))}
      compactLabel={`${urgent.remaining}%`}
    >
      <LimitsPanel entries={entries} machineLabel={machineLabel} />
    </FooterChip>
  );
}
