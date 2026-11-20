const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatScheduledTaskInterval(
  everyMs: number,
  t: Translator /* fork: i18n */,
): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, every, singular, plural] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return every;
    parts.push((count === 1 ? singular : plural).replace("{count}", String(count)));
    remaining %= size;
  }
  return `Every ${parts.join(" ")}`;
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

/** A time of day in the interface language, like the web's timestamps. */
export function formatScheduledTaskTime(date: Date, locale: UiLocale): string {
  return date.toLocaleTimeString(
    uiFormatLocale(locale),
    uiFormatOptions(locale, { hour: "numeric", minute: "2-digit" }),
  );
}

// fork: Hermes on Android names weekdays in English whatever the locale.
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function formatNextScheduledTaskRun(
  nextRunAt: string,
  now: number,
  locale: UiLocale, // fork: interface language
): string {
  const t = (source: string, params?: Record<string, string | number>) =>
    translate(locale, source, params);
  const formatTag = uiFormatLocale(locale);
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return "Next run unavailable";
  if (remaining <= 0) return "Next run due";

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return "Next run in less than a minute";
    const minutes = Math.round(remaining / MINUTE);
    const count = minutes < 60 ? minutes : Math.round(remaining / HOUR);
    if (minutes < 60) {
      return count === 1
        ? t("Next run in {count} minute", { count })
        : t("Next run in {count} minutes", { count });
    }
    return count === 1
      ? t("Next run in {count} hour", { count })
      : t("Next run in {count} hours", { count });
  }

  const time = formatScheduledTaskTime(next, locale);
  if (days === 1) return t("Next run tomorrow at {time}", { time });
  if (days <= 7) {
    return t("Next run next {weekday} at {time}", {
      weekday:
        locale === "en"
          ? next.toLocaleDateString(formatTag, { weekday: "long" })
          : t(WEEKDAY_NAMES[next.getDay()]!),
      time,
    });
  }
  const date = next.toLocaleDateString(formatTag, {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return `Next run ${date} at ${time}`;
}
