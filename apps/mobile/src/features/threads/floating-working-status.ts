import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { interpolate, type Translator } from "@t3tools/client-runtime/i18n"; // fork: i18n

const untranslated: Translator = (source, params) => interpolate(source, params); // fork: i18n

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "stop";
      readonly label: string;
      readonly unresponsive: boolean;
      readonly action: FloatingStatusAction | null;
    }
  | { readonly kind: "goal"; readonly label: string; readonly accessibilityLabel: string }
  | { readonly kind: "extension"; readonly label: string; readonly onPress: () => void }
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly label: string;
      readonly onPress: () => void;
    };

/** A connection still retrying on its own; short enough for the thread header subtitle. */
export function connectionRetryLabel(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionAwaitingApproval?: boolean;
  readonly t?: Translator; // fork: interface language, English when omitted
}): string | null {
  const t = input.t ?? untranslated; // fork: i18n
  if (input.connectionState === "reconnecting" && input.connectionAwaitingApproval) {
    return t("Awaiting device approval");
  }
  if (input.connectionState !== "connecting" && input.connectionState !== "reconnecting") {
    return null;
  }
  return input.connectionError === null ? t("Reconnecting…") : t("Retrying connection…");
}

export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
  readonly t?: Translator; // fork: interface language, English when omitted
}): FloatingWorkingStatus | null {
  const t = input.t ?? untranslated; // fork: i18n
  const environmentLabel = input.environmentLabel ?? t("Environment");
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "offline":
      return unavailable(t("You are offline"));
    case "unsupported":
      return unavailable(t("Client not supported"));
    case "error":
      return unavailable(
        input.connectionError
          ? t("Failed to connect to {name}: {error}", {
              name: environmentLabel,
              error: input.connectionError,
            })
          : t("Failed to connect to {name}", { name: environmentLabel }),
      );
    case "available":
      return unavailable(t("{name} is not connected", { name: environmentLabel }));
    case "connecting":
    case "reconnecting":
    case "connected":
      return null;
  }
}
