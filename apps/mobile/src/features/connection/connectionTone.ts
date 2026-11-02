import type { StatusTone } from "../../components/StatusPill";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { getUiLocale, translatorFor } from "@t3tools/client-runtime/i18n"; // fork: i18n

export function connectionTone(state: RemoteClientConnectionState): StatusTone {
  switch (state) {
    case "connected":
      return {
        label: translatorFor(getUiLocale())("Connected"),
        pillClassName: "bg-adaptive-emerald-500-a12-a16",
        textClassName: "text-adaptive-emerald-700-300",
      };
    case "reconnecting":
      return {
        label: translatorFor(getUiLocale())("Reconnecting"),
        pillClassName: "bg-warning",
        textClassName: "text-warning-foreground",
      };
    case "connecting":
      return {
        label: translatorFor(getUiLocale())("Connecting"),
        pillClassName: "bg-update",
        textClassName: "text-update-foreground",
      };
    case "unsupported":
      return {
        label: translatorFor(getUiLocale())("Client not supported"),
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-secondary",
      };
    case "error":
      return {
        label: translatorFor(getUiLocale())("Connection failed"),
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
      };
    case "offline":
      return {
        label: translatorFor(getUiLocale())("Offline"),
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
      };
    case "available":
      return {
        label: translatorFor(getUiLocale())("Available"),
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-secondary",
      };
  }
}
