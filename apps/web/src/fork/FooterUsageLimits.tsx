import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { useMessages } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import * as Duration from "effect/Duration";
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
import { type FooterChipSize, type FooterDensity, footerChipSize } from "./footerDensity.logic";
import {
  collectFooterLimits,
  type FooterLimitEntry,
  footerLimitsStaleAfterMs,
  mostUrgentLimit,
  windowHasReset,
} from "./footerLimits.logic";

function providerLabel(provider: ServerProvider): string {
  if (provider.displayName) return provider.displayName;
  const presentation = Object.values(PROVIDER_PRESENTATION).find(
    (entry) => entry.driverKind === provider.driver,
  );
  return presentation?.label ?? provider.driver;
}

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const NO_PROVIDERS_ATOM = Atom.make<ReadonlyArray<ServerProvider> | null>(null);
const NO_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null);

/**
 * Usable subscription windows of the shown environment, one entry per provider. Windows that have
 * reset and readings older than twice the server's refresh interval no longer set the color; the
 * minute clock re-evaluates both without any extra refresh.
 */
export function useFooterLimits(environmentId: EnvironmentId | null): readonly FooterLimitEntry[] {
  const providers = useAtomValue(
    environmentId === null
      ? NO_PROVIDERS_ATOM
      : serverEnvironment.providersValueAtom(environmentId),
  );
  const settings = useAtomValue(
    environmentId === null ? NO_SETTINGS_ATOM : serverEnvironment.settingsValueAtom(environmentId),
  );
  const now = Date.parse(`${useNowMinute()}Z`);
  const refreshInterval = resolveServerBackgroundActivitySettings(
    settings ?? DEFAULT_SERVER_SETTINGS,
  ).providerHealthRefreshInterval;
  return collectFooterLimits(providers ?? EMPTY_PROVIDERS, providerLabel, {
    now,
    staleAfterMs: footerLimitsStaleAfterMs(Duration.toMillis(refreshInterval)),
  });
}

function limitsLabels(entries: readonly FooterLimitEntry[]) {
  const urgent = mostUrgentLimit(entries);
  return {
    full: entries.map((entry) => `${entry.label} ${entry.remaining}%`).join(" · "),
    // The tightest provider by name, so a bare percentage never has to be guessed at.
    compact: urgent === null ? "" : `${urgent.label} ${urgent.remaining}%`,
  };
}

export function footerLimitsSize(entries: readonly FooterLimitEntry[]): FooterChipSize {
  return footerChipSize(limitsLabels(entries));
}

function LimitsPanel(props: {
  readonly entries: readonly FooterLimitEntry[];
  readonly machineLabel: string | null;
}) {
  const { entries, machineLabel } = props;
  const t = useT();
  const m = useMessages();
  const navigate = useNavigate();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  // Only mounted while the panel is open, so the minute clock runs only then.
  const now = Date.parse(`${useNowMinute()}Z`);
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
              const reset = windowHasReset(window, now);
              return (
                <div key={window.id} className="flex flex-col text-2xs text-muted-foreground">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{window.label}</span>
                    <span
                      className={`shrink-0 tabular-nums ${
                        window === entry.tightest ? FOOTER_TONE_CLASS[entry.severity] : ""
                      }`}
                    >
                      {reset ? t("resets now") : t("{remaining}% left", { remaining })}
                    </span>
                  </div>
                  {window.resetsAt && !reset && Number.isFinite(resetsAt) ? (
                    <span className="truncate tabular-nums">
                      {t("Resets in {duration} · {time}", {
                        duration: formatDuration(resetsAt - now, m),
                        time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now),
                      })}
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
      compactLabel={limitsLabels(entries).compact}
    >
      <LimitsPanel entries={entries} machineLabel={machineLabel} />
    </FooterChip>
  );
}
