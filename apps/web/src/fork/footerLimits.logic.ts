import {
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { limitsNotice, remainingPercent } from "@t3tools/shared/usageLimits";

export type FooterLimitSeverity = "ok" | "warning" | "danger";

/** Remaining share under which the chip turns to the warning and danger colors. */
const FOOTER_LIMIT_WARNING_BELOW = 20;
const FOOTER_LIMIT_DANGER_BELOW = 5;

const KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

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
  readonly remaining: number;
  readonly severity: FooterLimitSeverity;
  readonly tightest: ServerProviderUsageWindow;
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
    const tightest = tightestUsageWindow(limits.windows);
    if (tightest === null) continue;
    const remaining = remainingPercent(tightest);
    entries.push({
      instanceId: provider.instanceId,
      label: labelOf(provider),
      remaining,
      severity: footerLimitSeverity(remaining),
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
