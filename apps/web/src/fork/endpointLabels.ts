// fork: interface language. The desktop app names its own endpoints in English and sends the
// names as data, so the Settings page translates the known ones when it draws them. A host name
// (the address of a computer on your own server) and any other label are shown as they came.
import type { Translator } from "@t3tools/client-runtime/i18n";

export function endpointLabel(t: Translator, label: string): string {
  switch (label) {
    case "This machine":
      return t("This machine");
    case "Local network":
      return t("Local network");
    case "Tailscale IP":
      return t("Tailscale IP");
    case "Custom HTTPS":
      return t("Custom HTTPS");
    case "Custom endpoint":
      return t("Custom endpoint");
    default:
      return label;
  }
}
