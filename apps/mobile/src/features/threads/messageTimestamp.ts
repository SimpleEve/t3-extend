import type { UiLocale } from "@t3tools/client-runtime/i18n"; // fork: i18n

import { messageTimeLabel, uiFormatLocale } from "../../lib/time"; // fork: i18n

// fork: i18n. The day formatters follow the interface language; English keeps the device locale.
const dateFormatters = new Map<UiLocale, Intl.DateTimeFormat>();
const dateWithYearFormatters = new Map<UiLocale, Intl.DateTimeFormat>();

function dateFormatter(locale: UiLocale, withYear: boolean): Intl.DateTimeFormat {
  const cache = withYear ? dateWithYearFormatters : dateFormatters;
  let formatter = cache.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(uiFormatLocale(locale), {
      month: "numeric",
      day: "numeric",
      ...(withYear ? { year: "numeric" as const } : {}),
    });
    cache.set(locale, formatter);
  }
  return formatter;
}

/** Time only for today's messages; older ones lead with the day and month. */
export function formatMessageTimestamp(
  input: string,
  nowMs: number = Date.now(),
  locale: UiLocale = "en", // fork: i18n
): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return "";
  const date = new Date(timestamp);
  const now = new Date(nowMs);
  const time = messageTimeLabel(timestamp, locale);
  if (date.toDateString() === now.toDateString()) return time;
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${dateFormatter(locale, !sameYear).format(date)} ${time}`;
}
