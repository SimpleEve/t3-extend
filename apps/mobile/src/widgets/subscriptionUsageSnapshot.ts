import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  collectLimitAccounts,
  collectLimitPools,
  remainingPercent,
  type LimitAccount,
  type LimitPoolWindow,
  type LimitPresentations,
  usageWindowLabel, // fork: i18n
} from "@t3tools/shared/usageLimits";

import { translatorFor, type Translator, type UiLocale } from "@t3tools/client-runtime/i18n"; // fork: i18n

import { providerColors } from "../features/usage/providerColors";
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
    left: t("left"),
    moreInApp: t("{count} more in T3"),
    noSessionLimit: t("No session limit reported"),
    noWeeklyLimit: t("No weekly limit reported"),
    providerSpoken: t("{provider}. {detail}."),
    windowSpoken: t("{provider}, {label}, {percent} percent remaining. {reset}. {detail}."),
  };
}

export interface WidgetLimitAccount {
  name: string;
  color?: string;
  /** Absent when this account does not report the window. */
  remaining?: number;
  refill?: number;
  resetsAt?: number;
  reset?: string;
  durationMs?: number;
}

export interface SubscriptionUsageSnapshot {
  theme?: WidgetTheme;
  url?: string;
  checkedAt: number;
  /** `checkedAt` as an "As of ..." line, formatted for the interface language. */
  checkedAtLabel?: string; // fork: i18n
  strings?: SubscriptionUsageStrings; // fork: i18n
  providers: Array<{
    name: string;
    colors?: { light: string; dark: string };
    detail: string;
    windows: Array<{
      kind?: string;
      label: string;
      remaining: number;
      reset: string;
      accounts?: WidgetLimitAccount[];
    }>;
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

// Widget snapshots must not persist account emails.
function accountName(account: LimitAccount, t: Translator) {
  if (account.displayName && !account.displayName.includes("@")) return account.displayName;
  const email = account.email ?? account.displayName;
  if (!email?.includes("@")) return t("Account"); // fork: i18n
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase();
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const; // fork: i18n

function clockLabel(at: number, from: number, locale: UiLocale) {
  const time = { hour: "numeric", minute: "2-digit" } as const;
  // fork: i18n. Hermes names weekdays in English whatever the locale, so they come from the catalog.
  const tag = uiFormatLocale(locale);
  const clock = () => new Date(at).toLocaleTimeString(tag, uiFormatOptions(locale, time));
  if (new Date(at).toDateString() === new Date(from).toDateString()) return clock();
  if (at - from < 6 * 86_400_000)
    return locale === "en"
      ? new Date(at).toLocaleString(undefined, { weekday: "short", ...time })
      : `${translatorFor(locale)(WEEKDAYS[new Date(at).getDay()]!)} ${clock()}`;
  return new Date(at).toLocaleString(
    tag,
    uiFormatOptions(locale, { month: "short", day: "numeric" }),
  );
}

function widgetAccounts(window: LimitPoolWindow, locale: UiLocale): WidgetLimitAccount[] {
  const t = translatorFor(locale); // fork: i18n
  const seen = new Map<string, number>();
  return window.columns.map((column) => {
    // Redacted initials can collide, and the widget keys segments by name.
    const base = accountName(column.account, t);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const color = normalizeProviderAccentColor(column.account.accentColor);
    // expo-widgets cannot convert an explicit undefined into a Kotlin value.
    const account = { name: count > 1 ? `${base}${count}` : base, ...(color && { color }) };
    if (column.window === null) return account;
    const checkedAt = Date.parse(column.account.limits.checkedAt);
    const resetsAt = column.window.resetsAt ? Date.parse(column.window.resetsAt) : NaN;
    // A reset at or before the observation already happened.
    const reset = resetsAt > checkedAt;
    return {
      ...account,
      remaining: remainingPercent(column.window),
      refill: reset ? column.refillPercent : 0,
      ...(reset && {
        resetsAt,
        reset: clockLabel(resetsAt, checkedAt, locale),
      }),
      ...(column.window.windowDurationMins && {
        durationMs: column.window.windowDurationMins * 60_000,
      }),
    };
  });
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
        const kind = driver === "codex" ? "codex" : "claude";
        const colors = { light: providerColors("light")[kind], dark: providerColors("dark")[kind] };
        if (!pool)
          return {
            name,
            colors,
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
          colors,
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
                accounts: widgetAccounts(window, locale),
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
