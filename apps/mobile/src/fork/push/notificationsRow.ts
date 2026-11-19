// fork: the Settings row that opens the notifications page, for builds without T3 Connect.
import type { Translator } from "@t3tools/client-runtime/i18n";

export const notificationsRow = (t: Translator) =>
  ({
    id: "SettingsNotifications",
    icon: "bell.badge",
    label: t("Notifications"),
    target: "SettingsNotifications",
  }) as const;

/**
 * Without T3 Connect that page holds only the push section: UnifiedPush on Android, APNs on iOS.
 * A phone with neither (a build without the native module) gets no row that leads to an
 * explanation alone.
 */
export const localNotificationsRows = (t: Translator, pushSupported: boolean) =>
  pushSupported ? [notificationsRow(t)] : [];
