// fork: work log phrases take an optional translator so a client can show them in its interface
// language. Each phrase is a whole sentence with its count, because word order differs by
// language. Without a translator the English is unchanged; mobile relies on that.

import { FORK_SYSTEM_NOTICES } from "@t3tools/shared/forkNotices";

/** Translates an English source phrase; `{name}` placeholders take `params`. */
export type WorkLogPhraseTranslator = (
  source: string,
  params?: Readonly<Record<string, string | number>>,
  context?: string,
) => string;

export const englishWorkLogPhrase: WorkLogPhraseTranslator = (source, params) =>
  source.replace(/\{(\w+)\}/g, (match, name: string) =>
    params && Object.hasOwn(params, name) ? String(params[name]) : match,
  );

/** A system notice's label, translated only when T3 worded it: agent and user text is never looked up. */
export const translateForkNotice = (label: string, t: (source: string) => string): string =>
  FORK_SYSTEM_NOTICES.has(label) ? t(label) : label;
