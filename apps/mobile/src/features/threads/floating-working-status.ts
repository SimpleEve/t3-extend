import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { interpolate, type Translator } from "@t3tools/client-runtime/i18n"; // fork: i18n
import type { EnvironmentId } from "@t3tools/contracts";

const untranslated: Translator = (source, params) => interpolate(source, params); // fork: i18n

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly environmentId: EnvironmentId; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "background";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly waiting: boolean;
      readonly onPress: () => void;
      readonly action: FloatingStatusAction;
    }
  | {
      readonly kind: "lifecycle";
      readonly state: "snoozed" | "settled" | "woke";
      readonly label: string;
      readonly action: FloatingStatusAction;
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
      readonly tone: "reconnecting" | "unavailable";
      readonly label: string;
      readonly onPress: () => void;
    };

export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionAwaitingApproval?: boolean;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
  readonly t?: Translator; // fork: interface language, English when omitted
}): FloatingWorkingStatus | null {
  const t = input.t ?? untranslated; // fork: i18n
  const environmentLabel = input.environmentLabel ?? t("Environment");
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  if (input.connectionState === "reconnecting" && input.connectionAwaitingApproval) {
    return {
      kind: "connection",
      tone: "reconnecting",
      label: `Waiting for ${environmentLabel} to approve this device`,
      onPress: input.onReconnect,
    };
  }
  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "connection",
        tone: "reconnecting",
        label:
          input.connectionError === null
            ? t("Reconnecting to {name}...", { name: environmentLabel })
            : t("Failed to connect. Retrying {name}...", { name: environmentLabel }),
        onPress: input.onReconnect,
      };
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
    case "connected":
      return null;
  }
}
