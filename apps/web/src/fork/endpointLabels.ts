// fork: interface language. The desktop app names its own endpoints in English and sends the
// names as data, so the Settings page translates the known ones when it draws them. A host name
// (the address of a computer on your own server) and any other label are shown as they came.
// `endpointShareHint` (upstream) returns English sentences, translated here the same way.
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

export function endpointHint(t: Translator, hint: string): string {
  switch (hint) {
    case "Opens the hosted app, no install needed":
      return t("Opens the hosted app, no install needed");
    case "Devices on the same network":
      return t("Devices on the same network");
    case "Devices on your private network":
      return t("Devices on your private network");
    case "Reachable from anywhere":
      return t("Reachable from anywhere");
    case "Clients on this machine":
      return t("Clients on this machine");
    default:
      return hint;
  }
}
