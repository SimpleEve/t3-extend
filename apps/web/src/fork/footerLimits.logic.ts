import {
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";

export type FooterLimitSeverity = "ok" | "warning" | "danger";

/** Remaining share under which the chip turns to the warning and danger colors. */
const FOOTER_LIMIT_WARNING_BELOW = 20;
const FOOTER_LIMIT_DANGER_BELOW = 5;

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;

const KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/** A window whose reset time has passed has reset, whatever its last reading said. */
export function windowHasReset(window: ServerProviderUsageWindow, now: number): boolean {
  if (window.resetsAt === undefined) return false;
  const resetsAt = Date.parse(window.resetsAt);
  return Number.isFinite(resetsAt) && resetsAt <= now;
}

/**
 * How old a reading may get before the chip stops coloring it: twice the interval at which the
 * server refreshes provider status (Settings > Maintenance > Background activity), since one
 * missed refresh is not yet stale. A refresh that is switched off falls back to the default.
 */
export function footerLimitsStaleAfterMs(refreshIntervalMs: number): number {
  return 2 * (refreshIntervalMs > 0 ? refreshIntervalMs : DEFAULT_REFRESH_INTERVAL_MS);
}

export function footerLimitSeverity(remaining: number): FooterLimitSeverity {
  if (remaining < FOOTER_LIMIT_DANGER_BELOW) return "danger";
  if (remaining < FOOTER_LIMIT_WARNING_BELOW) return "warning";
  return "ok";
}

/** The window with the least left. Ties go to the shorter kind (session before weekly). */
export function tightestUsageWindow(
  windows: readonly ServerProviderUsageWindow[],
): ServerProviderUsageWindow | null {
  let tightest: ServerProviderUsageWindow | null = null;
  for (const window of windows) {
    if (
      tightest === null ||
      window.usedPercent > tightest.usedPercent ||
      (window.usedPercent === tightest.usedPercent &&
        KIND_ORDER[window.kind] < KIND_ORDER[tightest.kind])
    ) {
      tightest = window;
    }
  }
  return tightest;
}

export interface FooterLimitEntry {
  readonly instanceId: string;
  readonly label: string;
  /** Share left in the tightest window that has not reset; 100 when every window has. */
  readonly remaining: number;
  /** Never above "ok" for an old reading. */
  readonly severity: FooterLimitSeverity;
  readonly tightest: ServerProviderUsageWindow | null;
  readonly windows: readonly ServerProviderUsageWindow[];
  readonly checkedAt: string;
}

/**
 * One entry per usable provider. A provider with no readable window (unsupported, probe failed,
 * disabled, not installed) is left out, so an environment with nothing to show shows no chip.
 */
export function collectFooterLimits(
  providers: readonly ServerProvider[],
  labelOf: (provider: ServerProvider) => string,
  clock: { readonly now: number; readonly staleAfterMs: number },
): readonly FooterLimitEntry[] {
  const entries: FooterLimitEntry[] = [];
  for (const provider of providers) {
    const limits = provider.usageLimits;
    if (
      !limits ||
      !provider.enabled ||
      !provider.installed ||
      !isProviderAvailable(provider) ||
      limitsNotice(limits) !== null
    ) {
      continue;
    }
    if (limits.windows.length === 0) continue;
    const tightest = tightestUsageWindow(
      limits.windows.filter((window) => !windowHasReset(window, clock.now)),
    );
    const remaining = tightest === null ? 100 : remainingPercent(tightest);
    const checkedAt = Date.parse(limits.checkedAt);
    const stale = Number.isFinite(checkedAt) && clock.now - checkedAt > clock.staleAfterMs;
    entries.push({
      instanceId: provider.instanceId,
      label: labelOf(provider),
      remaining,
      severity: stale ? "ok" : footerLimitSeverity(remaining),
      tightest,
      windows: [...limits.windows].sort(
        (left, right) =>
          KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
          (left.windowDurationMins ?? 0) - (right.windowDurationMins ?? 0),
      ),
      checkedAt: limits.checkedAt,
    });
  }
  return entries;
}

/** The most urgent entry, which the compact chip stands for. */
export function mostUrgentLimit(entries: readonly FooterLimitEntry[]): FooterLimitEntry | null {
  let urgent: FooterLimitEntry | null = null;
  for (const entry of entries) {
    if (urgent === null || entry.remaining < urgent.remaining) urgent = entry;
  }
  return urgent;
}
