import type { UiLocale } from "./locale.ts";
import { translate } from "./translate.ts";

type ElapsedUnit =
  | { readonly unit: "now" }
  | { readonly unit: "m" | "h" | "d"; readonly count: number };

function elapsedUnit(elapsedMs: number): ElapsedUnit {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return { unit: "now" };
  if (minutes < 60) return { unit: "m", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "h", count: hours };
  return { unit: "d", count: Math.floor(hours / 24) };
}

/**
 * "5m ago" as one whole phrase, so languages with another word order translate
 * the sentence instead of a suffix. Avoids `Intl.RelativeTimeFormat`, which
 * Hermes may lack.
 */
export function formatRelativeElapsedLabel(locale: UiLocale, elapsedMs: number): string {
  const elapsed = elapsedUnit(elapsedMs);
  switch (elapsed.unit) {
    case "now":
      return translate(locale, "just now");
    case "m":
      return translate(locale, "{count}m ago", { count: elapsed.count });
    case "h":
      return translate(locale, "{count}h ago", { count: elapsed.count });
    case "d":
      return translate(locale, "{count}d ago", { count: elapsed.count });
  }
}

/** The same elapsed time without "ago", for dense rows: "5m", or "now". */
export function formatCompactElapsedLabel(locale: UiLocale, elapsedMs: number): string {
  const elapsed = elapsedUnit(elapsedMs);
  switch (elapsed.unit) {
    case "now":
      return translate(locale, "now");
    case "m":
      return translate(locale, "{count}m", { count: elapsed.count });
    case "h":
      return translate(locale, "{count}h", { count: elapsed.count });
    case "d":
      return translate(locale, "{count}d", { count: elapsed.count });
  }
}
