import {
  getUiLocale,
  translate,
  uiLocaleFormatTag,
  type Translator,
} from "@t3tools/client-runtime/i18n";
import type { EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  pickSnoozePreset as pickSharedSnoozePreset,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel as sharedSnoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";
import { toastManager } from "./ui/toast";

export { type SnoozePreset };

/** fork: the shared wake label ("60m", "now") in the interface language, keeping its rounding. */
export function snoozeWakeLabel(
  snoozedUntil: string,
  options: { readonly now: string },
  t: Translator,
): string {
  return sharedSnoozeWakeLabel(snoozedUntil, {
    now: options.now,
    // "now" alone reads as "just now"; here it means the wake is due.
    translate: (source, params) => t(source, params, "time remaining"),
  });
}

/** The snooze menu for a thread, from its environment's presets, read when the menu opens. */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now, snoozeOptions(timestampFormat, environmentId));
}

/** A shown menu choice as picked; see the shared `pickSnoozePreset`. */
export function pickSnoozePreset(
  shown: ReadonlyArray<SnoozePreset>,
  id: string,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): SnoozePreset | undefined {
  const picked = pickSharedSnoozePreset({
    shown,
    id,
    now: new Date(),
    ...snoozeOptions(timestampFormat, environmentId),
  });
  if (!picked) {
    toastManager.add({
      type: "warning",
      title: "Could not snooze thread",
      description: "That snooze time has passed. Choose another time.",
    });
  }
  return picked;
}

function snoozeOptions(timestampFormat: TimestampFormat, environmentId: EnvironmentId) {
  const presets = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.snoozePresets;
  return {
    ...(presets ? { presets } : {}),
    formatTime: (date: Date) => formatShortTimestamp(date.toISOString(), timestampFormat),
    // fork: presets resolve when a menu opens, so the label reads the language at that moment.
    translate: (source: string, params?: Readonly<Record<string, string | number>>) =>
      translate(getUiLocale(), source, params),
    locale: uiLocaleFormatTag(getUiLocale()), // fork: "Thu 9:00" follows the interface
  };
}
