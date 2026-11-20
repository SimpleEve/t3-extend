import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";

export function environmentStatusText(
  connection: EnvironmentConnectionPresentation,
  t: Translator,
): string {
  if (connection.phase === "unsupported" && connection.error !== null) return connection.error;
  // fork: i18n. Phrases with a server error keep the error as is and translate around it.
  if (connection.phase === "reconnecting" && connection.error) {
    return t("Failed to connect. Reconnecting... Reason: {error}", { error: connection.error });
  }
  if (connection.phase === "error" && connection.error) {
    return t("Connection failed. Reason: {error}", { error: connection.error });
  }
  return t(connectionStatusText({ ...connection, error: null }));
}
