// fork: i18n. Spoken labels assembled in JS take the language's punctuation (full-width in Chinese).
import type { Translator } from "@t3tools/client-runtime/i18n";

export function joinLabelParts(
  parts: ReadonlyArray<string | null | undefined | false>,
  t: Translator,
): string {
  return parts.filter(Boolean).join(t(", ", undefined, "tool summary"));
}

export function labelWithDetail(label: string, detail: string, t: Translator): string {
  return t("{label}: {detail}", { label, detail });
}
