import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitAccount,
  type LimitPoolWindow,
  type LimitPresentations,
  usageWindowLabel, // fork: i18n
} from "@t3tools/shared/usageLimits";

import { translatorFor, type Translator, type UiLocale } from "@t3tools/client-runtime/i18n"; // fork: i18n

import { uiFormatLocale, uiFormatOptions } from "../lib/time"; // fork: i18n
import type { WidgetTheme } from "./widgetTheme";

// fork: i18n. The widget runtime has no app module scope and no catalog, so the app sends the
// strings it shows, in the interface language. A widget falls back to English when one is missing.
export type SubscriptionUsageStrings = Readonly<Record<string, string>>;

export function subscriptionUsageStrings(t: Translator): SubscriptionUsageStrings {
  return {
    connect: t("Open T3 to connect"),
    refresh: t("Open T3 to refresh"),
    remaining: t("Subscription remaining"),
    open: t("Open T3"),
    notAvailable: t("N/A"),
    tapToConnect: t("Tap to connect in T3"),
    noLimits: t("No subscription limits available."),
    percentLeft: t("{percent}% left"),
    moreInApp: t("{count} more in T3"),
    noSessionLimit: t("No session limit reported"),
    noWeeklyLimit: t("No weekly limit reported"),
    providerSpoken: t("{provider}. {detail}."),
    windowSpoken: t("{provider}, {label}, {percent} percent remaining. {reset}. {detail}."),
  };
}

export interface SubscriptionUsageSnapshot {
  theme?: WidgetTheme;
  url?: string;
  checkedAt: number;
  /** `checkedAt` as an "As of ..." line, formatted for the interface language. */
  checkedAtLabel?: string;
  strings?: SubscriptionUsageStrings;
  providers: Array<{
    name: string;
    detail: string;
    windows: Array<{ kind?: string; label: string; remaining: number; reset: string }>;
    expiresAt: number;
    totalWindows: number;
  }>;
}

// Snapshots expire after 15 minutes; suspended refresh requires a separate authenticated transport.
const SNAPSHOT_MAX_AGE = 15 * 60_000;
export const WIDGET_REFRESH_INTERVAL = 5 * 60_000;

export function createWidgetRefresher<Id>(refresh: (id: Id) => Promise<unknown>) {
  const attempted = new Map<Id, number>();
  const pending = new Set<Id>();
  return async (connected: readonly Id[], now: number) => {
    await Promise.allSettled(
      connected.map(async (id) => {
        if (pending.has(id) || now - (attempted.get(id) ?? -Infinity) < WIDGET_REFRESH_INTERVAL)
          return;
        attempted.set(id, now);
        pending.add(id);
        try {
          await refresh(id);
        } finally {
          pending.delete(id);
        }
      }),
    );
  };
}

// A reset at or before its account's observation already happened, so it cannot expire the snapshot.
const isUpcoming = (reset: LimitPoolWindow["resets"][number]) =>
  reset.at > Date.parse(reset.member.account.limits.checkedAt);

function subscriptionUsageProps(
  accounts: readonly LimitAccount[],
  now: number,
  configuredDrivers: ReadonlySet<string>,
  maxWindowsPerProvider: number,
  locale: UiLocale,
): SubscriptionUsageSnapshot {
  const t = translatorFor(locale);
  const formatDate = (at: number, options: Intl.DateTimeFormatOptions) =>
    new Date(at).toLocaleString(uiFormatLocale(locale), uiFormatOptions(locale, options));
  const pools = collectLimitPools(accounts, now);
  const checked = accounts
    .filter((account) => account.driver === "codex" || account.driver === "claudeAgent")
    .map((account) => Date.parse(account.limits.checkedAt));
  const checkedAt = checked.length > 0 && checked.every(Number.isFinite) ? Math.min(...checked) : 0;
  return {
    checkedAt,
    checkedAtLabel: checkedAt
      ? t("As of {time}", {
          time: formatDate(checkedAt, {
            hour: "numeric",
            minute: "2-digit",
            month: "short",
            day: "numeric",
          }),
        })
      : undefined,
    strings: subscriptionUsageStrings(t),
    providers: (["codex", "claudeAgent"] as const)
      .filter(
        (driver) =>
          configuredDrivers.has(driver) || accounts.some((account) => account.driver === driver),
      )
      .map((driver) => {
        const pool = pools.find((candidate) => candidate.driver === driver);
        const name = driver === "codex" ? "Codex" : "Claude";
        if (!pool)
          return {
            name,
            detail: t("No limits available"),
            windows: [],
            expiresAt: 0,
            totalWindows: 0,
          };
        const checkedAt = Math.min(...pool.accounts.map((a) => Date.parse(a.limits.checkedAt)));
        const expiresAt = Math.min(
          checkedAt + SNAPSHOT_MAX_AGE,
          ...pool.windows.flatMap((window) =>
            window.resets.filter(isUpcoming).map((reset) => reset.at),
          ),
        );
        const fresh = Number.isFinite(expiresAt) && expiresAt > now;
        const sortedWindows = [...pool.windows].sort(
          (a, b) => a.remainingPercent - b.remainingPercent,
        );
        const selectedWindows = [
          ...new Set([
            sortedWindows.find((window) => window.kind === "session"),
            sortedWindows.find((window) => window.kind === "weekly"),
            ...sortedWindows,
          ]),
        ]
          .filter((window) => window !== undefined)
          .slice(0, maxWindowsPerProvider)
          .sort((a, b) => a.remainingPercent - b.remainingPercent);
        return {
          name,
          detail: !fresh
            ? t("Open T3 to refresh")
            : pool.accounts.length > 1
              ? t("{count} accounts · pooled", { count: String(pool.accounts.length) })
              : t("Subscription remaining"),
          expiresAt: fresh ? expiresAt : 0,
          totalWindows: fresh ? pool.windows.length : 0,
          windows: fresh
            ? selectedWindows.map((window) => ({
                kind: window.kind,
                label: usageWindowLabel(window.label, t),
                remaining: Math.round(window.remainingPercent),
                reset: window.resets[0]
                  ? t(isUpcoming(window.resets[0]) ? "Next reset {time}" : "Reset {time}", {
                      time: formatDate(window.resets[0].at, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    })
                  : t("Reset time unavailable"),
              }))
            : [],
        };
      }),
  };
}

export function buildSubscriptionUsageSnapshot(
  presentations: LimitPresentations,
  url: string,
  maxWindowsPerProvider = 6,
  locale: UiLocale = "en", // fork: i18n
): SubscriptionUsageSnapshot {
  const configuredDrivers = new Set(
    [...presentations.values()].flatMap((presentation) =>
      (presentation.serverConfig?.providers ?? [])
        // Servers report default-enabled drivers even when their CLI is missing.
        .filter(
          (provider) =>
            provider.enabled &&
            provider.installed &&
            provider.usageLimits?.unavailable?.reason !== "unsupported",
        )
        .map((provider) => provider.driver),
    ),
  );
  return {
    ...subscriptionUsageProps(
      collectLimitAccounts(presentations),
      0,
      configuredDrivers,
      maxWindowsPerProvider,
      locale,
    ),
    url,
  };
}

export function subscriptionUsageTimeline(snapshot: SubscriptionUsageSnapshot, now: number) {
  const deadlines = [...new Set(snapshot.providers.map((p) => p.expiresAt))]
    .filter((deadline) => deadline > now)
    .sort((a, b) => a - b);
  return [now, ...deadlines].map((date) => ({
    date: new Date(date),
    props: {
      ...snapshot,
      providers: snapshot.providers.map((provider) =>
        provider.windows.length > 0 && provider.expiresAt <= date
          ? {
              ...provider,
              detail: snapshot.strings?.refresh ?? "Open T3 to refresh",
              windows: [],
              totalWindows: 0,
            }
          : provider,
      ),
    },
  }));
}
