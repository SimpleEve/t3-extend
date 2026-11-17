import type { UiLocale } from "@t3tools/client-runtime/i18n"; // fork: i18n

import { uiFormatLocale, uiFormatOptions } from "../../lib/time"; // fork: i18n

// Formatters pin the default zone when built, and Hermes keeps Date's local offset until a cold
// start (react/react-native#59131), so formatting and day checks follow the zone Intl reports.
// fork: i18n. The formatters follow the interface language; English keeps the device locale.
function buildFormatters(timeZone: string, locale: UiLocale) {
  const tag = uiFormatLocale(locale);
  return {
    timeZone,
    time: new Intl.DateTimeFormat(
      tag,
      uiFormatOptions(locale, { hour: "numeric", minute: "2-digit", timeZone }),
    ),
    date: new Intl.DateTimeFormat(tag, { month: "numeric", day: "numeric", timeZone }),
    dateWithYear: new Intl.DateTimeFormat(tag, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
      timeZone,
    }),
    year: new Intl.DateTimeFormat(tag, { year: "numeric", timeZone }),
  };
}

// Reading the zone builds a formatter (tens of µs), so feed rows share one read per second.
const ZONE_RECHECK_MS = 1_000;
const formattersByLocale = new Map<UiLocale, ReturnType<typeof buildFormatters>>();
let currentZone = "";
let zoneCheckedAt = 0;
function currentFormatters(locale: UiLocale) {
  const now = Date.now();
  if (currentZone === "" || Math.abs(now - zoneCheckedAt) >= ZONE_RECHECK_MS) {
    zoneCheckedAt = now;
    currentZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  const cached = formattersByLocale.get(locale);
  if (cached && cached.timeZone === currentZone) return cached;
  const built = buildFormatters(currentZone, locale);
  formattersByLocale.set(locale, built);
  return built;
}

/** Time only for today's messages; older ones lead with the day and month. */
export function formatMessageTimestamp(
  input: string,
  nowMs: number = Date.now(),
  timeFormatter?: Intl.DateTimeFormat,
  locale: UiLocale = "en", // fork: i18n
): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return "";
  const f = currentFormatters(locale);
  const time = (timeFormatter ?? f.time).format(timestamp);
  const dateWithYear = f.dateWithYear.format(timestamp);
  if (dateWithYear === f.dateWithYear.format(nowMs)) return time;
  const sameYear = f.year.format(timestamp) === f.year.format(nowMs);
  return `${sameYear ? f.date.format(timestamp) : dateWithYear} ${time}`;
}

/**
 * `is24Hour` overrides the locale's hour cycle with the system clock preference when known.
 * fork: i18n. `uiLocale` picks the interface language's format; Chinese is always 24-hour.
 */
export function createMessageTimeFormatter(
  is24Hour: boolean | undefined,
  locale?: string,
  uiLocale: UiLocale = "en",
) {
  let cached: { timeZone: string; formatter: Intl.DateTimeFormat } | null = null;
  return (input: string, nowMs?: number): string => {
    const { timeZone } = currentFormatters(uiLocale);
    if (cached?.timeZone !== timeZone) {
      cached = {
        timeZone,
        formatter: new Intl.DateTimeFormat(
          locale ?? uiFormatLocale(uiLocale),
          uiFormatOptions(uiLocale, {
            hour: "numeric",
            minute: "2-digit",
            timeZone,
            ...(is24Hour === undefined ? {} : { hourCycle: is24Hour ? "h23" : "h12" }),
          }),
        ),
      };
    }
    return formatMessageTimestamp(input, nowMs, cached.formatter, uiLocale);
  };
}
