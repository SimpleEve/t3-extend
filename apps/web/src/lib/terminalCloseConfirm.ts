import { getUiLocale, translate } from "@t3tools/client-runtime/i18n";
import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

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
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            translate(locale, 'Close terminal "{label}"?', { label: labels[0] }),
            translate(locale, "This stops the running process and clears its history."),
          ].join("\n")
        : [
            translate(locale, "Close {count} terminals?", { count: labels.length }),
            translate(
              locale,
              "This stops their running processes and clears their histories: {labels}.",
              {
                labels: labels.map((label) => `"${label}"`).join(translate(locale, ", ")),
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
