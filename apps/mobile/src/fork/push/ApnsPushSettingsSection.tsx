import type { Translator } from "@t3tools/client-runtime/i18n";
import { type EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { Linking } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { useT } from "../../hooks/useT";
import { SettingsRow } from "../../features/settings/components/SettingsRow";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../features/settings/components/SettingsSwitchRow";
import {
  disableApnsPush,
  enableApnsPush,
  retryApnsPush,
  sendApnsTestNotification,
} from "./apnsPushRegistration";
import { apnsSetupStep, type ApnsEnvironmentStatus, type ApnsFailureKind } from "./apnsPushModel";
import { useApnsPushState } from "./apnsPushStore";
import { pushEnvironment } from "./pushCommands";

// fork: iPhone push straight from the user's own server to Apple, with no relay in between.

export function ApnsPushSettingsSection() {
  const t = useT();
  const state = useApnsPushState();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const step = apnsSetupStep(state);
  if (step === "unsupported") return null;

  if (step === "free-account") {
    return (
      <SettingsSection title={t("Push notifications")}>
        <SettingsRow
          icon="slash.circle"
          label={t("Not available")}
          value={t("Push notifications aren't supported in builds made with a free Apple account.")}
          valuePosition="below"
        />
      </SettingsSection>
    );
  }

  const run = (action: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return Promise.resolve();
    inFlight.current = true;
    setBusy(true);
    return action().finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  };

  const toggle = (enabled: boolean) =>
    run(async () => {
      if (!enabled) {
        await disableApnsPush();
        return;
      }
      if ((await enableApnsPush()) === "permission-denied") {
        Dialog.alert(
          t("Notifications disabled"),
          t("Notifications were denied for this app. Open Settings to enable them."),
          [
            { text: t("Cancel"), style: "cancel" },
            { text: t("Open Settings"), onPress: () => void Linking.openSettings() },
          ],
        );
      }
    });

  const test = (environment: ApnsEnvironmentStatus) =>
    run(async () => {
      const outcome = await sendApnsTestNotification(environment.environmentId as EnvironmentId);
      const name = environment.label || t("this environment");
      if (outcome.kind === "unreachable") {
        Dialog.alert(
          t("Test notification failed"),
          t("Couldn't reach {environment}. Check the connection and try again.", {
            environment: name,
          }),
        );
        return;
      }
      const { result } = outcome;
      if (!result.registered) {
        Dialog.alert(
          t("Not registered yet"),
          t("{environment} has no registration for this phone yet. Try again in a moment.", {
            environment: name,
          }),
        );
      } else if (result.outcome === "delivered") {
        Dialog.alert(
          t("Test notification sent"),
          t("Apple accepted it. It should appear on this phone in a moment."),
        );
      } else if (result.outcome === "gone") {
        Dialog.alert(
          t("Registration expired"),
          t(
            "Apple no longer knows this phone, so {environment} removed the registration. Turn push notifications off and on again.",
            { environment: name },
          ),
        );
      } else if (result.outcome === "rejected") {
        Dialog.alert(
          t("Apple refused it"),
          t(
            "Apple's push service answered with an error (HTTP {status}). Check the APNs key on {environment}.",
            { status: result.httpStatus ?? 0, environment: name },
          ),
        );
      } else {
        Dialog.alert(
          t("Apple's push service unreachable"),
          t("{environment} couldn't reach Apple's push service. Check the server's network.", {
            environment: name,
          }),
        );
      }
    });

  const footer =
    step === "permission-denied"
      ? t("Notifications are turned off for this app in iOS Settings, so alerts won't show.")
      : undefined;

  return (
    <>
      <SettingsSection title={t("Push notifications")} footer={footer}>
        <SettingsSwitchRow
          icon="bell.badge"
          label={t("Push notifications")}
          subtitle={t("Sent from your own server straight to Apple's push service, with no relay.")}
          disabled={busy}
          value={state.enabled}
          onValueChange={(enabled) => void toggle(enabled)}
        />
        {step === "token-failed" ? (
          <>
            <SettingsRow
              icon="exclamationmark.triangle"
              label={t("No push token")}
              value={t(
                "Apple didn't give this app a push token. This build may be missing the Push Notifications capability.",
              )}
              valuePosition="below"
            />
            <SettingsRow
              icon="arrow.clockwise"
              label={t("Try again")}
              onPress={() => retryApnsPush()}
            />
          </>
        ) : null}
      </SettingsSection>
      {state.enabled && step !== "token-failed"
        ? state.environments.map((environment) => (
            <EnvironmentPushSection
              key={environment.environmentId}
              environment={environment}
              busy={busy}
              onTest={() => void test(environment)}
            />
          ))
        : null}
    </>
  );
}

function failureText(failure: ApnsFailureKind | undefined, t: Translator): string {
  switch (failure) {
    case "not-configured":
      return t("Not registered: this server has no APNs key");
    case "server-outdated":
      return t("Not registered: update this server to get push on iPhone");
    case "unreachable":
      return t("Not registered: can't reach this environment");
    case "timeout":
      return t("Not registered: this environment didn't answer");
    case "denied":
      return t("Not registered: this connection can't register devices");
    case "rejected":
      return t("Not registered: this environment refused the registration");
    case "invalid":
      return t("Not registered: this environment couldn't read the request");
    default:
      return t("Not registered");
  }
}

function EnvironmentPushSection(props: {
  readonly environment: ApnsEnvironmentStatus;
  readonly busy: boolean;
  readonly onTest: () => void;
}) {
  const t = useT();
  const { environment } = props;
  // The grant on that environment decides, as for every protected command.
  const canTest = useAtomValue(
    pushEnvironment.sendTest.permissionAtom(environment.environmentId as EnvironmentId),
  );
  const status =
    environment.state === "registered"
      ? t("Registered")
      : environment.state === "pending"
        ? t("Registering…")
        : environment.state === "waiting"
          ? t("Waiting for the connection…")
          : failureText(environment.failure, t);
  return (
    <SettingsSection
      title={environment.label || t("Environment")}
      footer={
        environment.failure === "not-configured"
          ? t("Set the T3EXTEND_APNS_* variables on that server and restart it.")
          : undefined
      }
    >
      <SettingsRow
        icon="checkmark.circle"
        label={t("Status")}
        value={status}
        valuePosition={environment.state === "failed" ? "below" : undefined}
      />
      <SettingsRow
        icon="bell.badge"
        label={t("Send test notification")}
        disabled={props.busy || !canTest || environment.state !== "registered"}
        onPress={props.onTest}
      />
    </SettingsSection>
  );
}
