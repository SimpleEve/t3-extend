import type { TerminalSummary } from "@t3tools/contracts";

function terminalNumber(terminalId: string): string | undefined {
  return /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(
    terminalId,
  )?.[1];
}

export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = terminalNumber(terminalId);
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}

/**
 * fork: the server names a terminal "Terminal N" and clients match on that name, so it stays
 * English as data. Show it in the interface language; any other name is shown as is.
 */
export function localizeTerminalLabel(
  label: string,
  t: (source: string, params?: Readonly<Record<string, string>>) => string,
): string {
  const number = /^Terminal (\d+)$/.exec(label)?.[1];
  return number === undefined ? label : t("Terminal {number}", { number });
}

export function resolveTerminalSessionLabel(
  terminalId: string,
  summary: Pick<TerminalSummary, "label"> | null | undefined,
): string {
  const trimmed = summary?.label?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return getTerminalLabel(terminalId);
}

/** Append a UUID when metadata is unavailable to avoid reusing unseen host sessions. */
export function nextTerminalId(
  existingTerminalIds: ReadonlyArray<string>,
  uniqueSuffix?: string,
): string {
  const usedNumbers = new Set(existingTerminalIds.map(terminalNumber));
  let nextIndex = 1;
  while (usedNumbers.has(String(nextIndex))) {
    nextIndex += 1;
  }

  return `term-${nextIndex}${uniqueSuffix === undefined ? "" : `-${uniqueSuffix}`}`;
}
