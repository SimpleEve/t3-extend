import { getUiLocale, translate } from "@t3tools/client-runtime/i18n";
import { localizeTerminalLabel } from "@t3tools/shared/terminalLabels"; // fork: i18n
import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

/** Whether a terminal-close action is waiting on settings or user confirmation. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export async function confirmTerminalClose(
  labels: readonly [string, ...string[]],
): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  const locale = getUiLocale();
  // fork: i18n. Show the generated "Terminal N" name in the interface language.
  const localize = (label: string) =>
    localizeTerminalLabel(label, (source, params) => translate(locale, source, params));
  const names = labels.map(localize);
  try {
    let shouldConfirm = true;
    try {
      await ensureClientSettingsHydrated();
      shouldConfirm = getClientSettings().confirmTerminalClose;
    } catch {
      // If saved settings cannot be read, keep the destructive confirmation.
    }
    if (!shouldConfirm) return true;
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            translate(locale, 'Close terminal "{label}"?', { label: localize(labels[0]) }),
            translate(locale, "This stops the running process and clears its history."),
          ].join("\n")
        : [
            translate(locale, "Close {count} terminals?", { count: labels.length }),
            translate(
              locale,
              "This stops their running processes and clears their histories: {labels}.",
              {
                labels: names.map((label) => `"${label}"`).join(translate(locale, ", ")),
              },
            ),
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
