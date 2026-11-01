// fork: translates the timeline's derived row labels when they render.
// Rows are computed once and structurally shared, so baking the language into them would keep
// the old language after a switch. The row keeps its English label; this matches it against
// the sources the row logic writes and translates the whole phrase, keeping its values.
import type { Translator } from "@t3tools/client-runtime/i18n";

const TIMELINE_LABEL_SOURCES = [
  "Worked for {duration}",
  "Worked",
  "You stopped after {duration}",
  "You stopped this response",
  "Continued for {duration}",
  "Continued",
  "Superseded attempt",
  "Compacting context",
  "Context compaction",
  "Context compaction failed",
  "Context compaction stopped",
  "Context compacted {before} → {after} tokens",
  "Context compacted",
  "Context compacted after {age} idle",
  "Context compacted before sending",
  "Context automatically compacted before cache expiry",
  "Compacting before the cache expires…",
  "Compacting…",
] as const;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MATCHERS = TIMELINE_LABEL_SOURCES.map((source) => {
  const names: string[] = [];
  const pattern = source
    .split(/(\{\w+\})/)
    .map((part) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      if (name === undefined) return escapeRegExp(part);
      names.push(name);
      return "(.+?)";
    })
    .join("");
  return { source, names, regex: new RegExp(`^${pattern}$`) };
});

/** The label in the interface language, or unchanged when it is not a known row label. */
export function translateTimelineLabel(label: string, t: Translator): string {
  for (const { source, names, regex } of MATCHERS) {
    const match = regex.exec(label);
    if (match === null) continue;
    return t(source, Object.fromEntries(names.map((name, index) => [name, match[index + 1]!])));
  }
  return label;
}
