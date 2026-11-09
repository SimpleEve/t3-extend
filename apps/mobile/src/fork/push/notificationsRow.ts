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
 * Without T3 Connect that page holds only the UnifiedPush section, so a phone that cannot use it
 * (iOS, a build without the native module) gets no row that leads to an explanation alone.
 */
export const localNotificationsRows = (t: Translator, unifiedPushSupported: boolean) =>
  unifiedPushSupported ? [notificationsRow(t)] : [];
