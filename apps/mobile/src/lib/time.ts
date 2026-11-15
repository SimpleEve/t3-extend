import {
  translatorFor,
  uiLocaleFormatTag,
  type Translator,
  type UiLocale,
} from "@t3tools/client-runtime/i18n"; // fork: i18n

// Host timestamps may carry UTC offsets or mixed fractions, so text order is not time order.
export function compareTimestamps(left: string, right: string): number {
  return (Date.parse(left) || 0) - (Date.parse(right) || 0);
}

export function byTimestamp(newestFirst: boolean) {
  return (left: { readonly date: string }, right: { readonly date: string }) =>
    newestFirst
      ? compareTimestamps(right.date, left.date)
      : compareTimestamps(left.date, right.date);
}

// fork: i18n. English keeps upstream's device locale (an en-GB phone stays 24-hour); Chinese
// formats as zh-CN and forces 24-hour, because Hermes can fall back to the device's 12-hour clock.
export function uiFormatLocale(locale: UiLocale): string | undefined {
  return locale === "en" ? undefined : uiLocaleFormatTag(locale);
}

export function uiFormatOptions(
  locale: UiLocale,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormatOptions {
  if (locale === "en") return options;
  // hour12 outranks hourCycle in the spec; drop it anyway rather than rely on Hermes following that.
  const { hourCycle: _deviceClock, ...rest } = options;
  return { ...rest, hour12: false };
}

const messageTimeFormatters = new Map<UiLocale, Intl.DateTimeFormat>();

/** A chat message's clock time, formatted for the interface language. */
export function messageTimeLabel(timestamp: number, locale: UiLocale): string {
  let formatter = messageTimeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      uiFormatLocale(locale),
      uiFormatOptions(locale, { hour: "numeric", minute: "2-digit" }),
    );
    messageTimeFormatters.set(locale, formatter);
  }
  return formatter.format(timestamp);
}

export function relativeTime(
  input: string,
  nowMs: number = Date.now(),
  t: Translator = translatorFor("en"), // fork: i18n
): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return t("<1m");
  }

  const deltaSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (deltaSeconds < 60) return t("<1m");

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return t("{count}m", { count: deltaMinutes });

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return t("{count}h", { count: deltaHours });

  const deltaDays = Math.floor(deltaHours / 24);
  return t("{count}d", { count: deltaDays });
}

/** Milliseconds until the relative-time label next changes. */
export function msUntilRelativeTimeChange(
  input: string,
  nowMs: number = Date.now(),
): number | null {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return null;
  const elapsedMs = Math.max(0, nowMs - timestamp);
  const unitMs = elapsedMs < 3_600_000 ? 60_000 : elapsedMs < 86_400_000 ? 3_600_000 : 86_400_000;
  const nextChangeMs = timestamp + (Math.floor(elapsedMs / unitMs) + 1) * unitMs;
  // Far-future timestamps must not overflow setTimeout's signed 32-bit delay.
  return Math.min(nextChangeMs - nowMs, 86_400_000);
}
