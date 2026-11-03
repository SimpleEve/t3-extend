// fork: the Settings row that opens the phone's "Your server" page.
import type { Translator } from "@t3tools/client-runtime/i18n";

export const serverDevicesRow = (t: Translator) =>
  ({
    id: "SettingsServerDevices",
    icon: "server.rack",
    label: t("Your server"),
    target: "SettingsServerDevices",
  }) as const;
