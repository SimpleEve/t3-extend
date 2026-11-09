import type { Translator } from "@t3tools/client-runtime/i18n";
import { type EnvironmentId } from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { Linking } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { useT } from "../../hooks/useT";
import { SettingsRow } from "../../features/settings/components/SettingsRow";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../features/settings/components/SettingsSwitchRow";
import {
  chooseUnifiedPushDistributor,
  disableUnifiedPush,
  enableUnifiedPush,
  sendTestNotification,
} from "./unifiedPushRegistration";
import {
  unifiedPushSetupStep,
  type EnvironmentPushStatus,
  type PushFailureKind,
} from "./pushRegistrationModel";
import { pushEnvironment } from "./pushCommands";
import { useUnifiedPushState } from "./pushStore";

// fork: push notifications through the user's own UnifiedPush server (ntfy and the like).
const SETUP_GUIDE_URL = `https://github.com/${FORK.releaseRepository}/blob/main/docs/user/mobile-notifications.md#push-without-google`;

export function UnifiedPushSettingsSection() {
  const t = useT();
  const state = useUnifiedPushState();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  if (!state.supported) return null;

  const { native } = state;
  const step = unifiedPushSetupStep(state);

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
        await disableUnifiedPush();
        return;
      }
      if ((await enableUnifiedPush()) === "permission-denied") {
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

  const test = (environment: EnvironmentPushStatus) =>
    run(async () => {
      const outcome = await sendTestNotification(environment.environmentId as EnvironmentId);
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
          t("The push server accepted it. It should appear on this phone in a moment."),
        );
      } else if (result.outcome === "gone") {
        Dialog.alert(
          t("Registration expired"),
          t(
            "The push server no longer knows this phone, so {environment} removed the registration. Turn push notifications off and on again.",
            { environment: name },
          ),
        );
      } else if (result.outcome === "rejected") {
        Dialog.alert(
          t("Push server refused it"),
          t(
            "The push server answered with an error (HTTP {status}). Check that it accepts writes to topics starting with up.",
            { status: result.httpStatus ?? 0 },
          ),
        );
      } else {
        Dialog.alert(
          t("Push server unreachable"),
          t(
            "{environment} couldn't reach the push server. Check the server's address and network.",
            {
              environment: name,
            },
          ),
        );
      }
    });

  // Some systems cut a push app's connection once it leaves the screen, so the endpoint can
  // wait until the app is opened or allowed to run in the background.
  const pushAppName =
    native.distributors.find((entry) => entry.id === native.distributor)?.label ??
    native.distributor ??
    "";
  const waitingHint =
    native.enabled &&
    (step === "waiting-for-endpoint" || step === "ready") &&
    !native.failure &&
    native.endpointHost === null
      ? t("Open {app} once. If it keeps waiting, allow it to run in the background.", {
          app: pushAppName,
        })
      : undefined;

  return (
    <>
      <SettingsSection title={t("Push without Google")} footer={waitingHint}>
        <SettingsSwitchRow
          icon="bell.badge"
          label={t("Push notifications")}
          subtitle={t(
            "Delivered by your own push server through UnifiedPush, with no Google services.",
          )}
          disabled={busy}
          value={native.enabled}
          onValueChange={(enabled) => void toggle(enabled)}
        />
        {native.enabled && step === "install-distributor" ? (
          <SettingsRow
            icon="questionmark.bubble"
            label={t("Set up a push app")}
            value={t(
              "Install ntfy from F-Droid, open it and set its server to your own, then come back here.",
            )}
            valuePosition="below"
            onPress={() => void Linking.openURL(SETUP_GUIDE_URL)}
          />
        ) : null}
        {native.enabled && step === "choose-distributor"
          ? native.distributors.map((distributor) => (
              <SettingsRow
                key={distributor.id}
                icon="server.rack"
                label={distributor.label}
                value={t("Use this push app")}
                valuePosition="below"
                onPress={() => chooseUnifiedPushDistributor(distributor.id)}
              />
            ))
          : null}
        {native.enabled && (step === "waiting-for-endpoint" || step === "ready") ? (
          <>
            <SettingsRow
              icon="server.rack"
              label={t("Push app")}
              value={
                native.distributors.find((entry) => entry.id === native.distributor)?.label ??
                native.distributor ??
                ""
              }
            />
            <SettingsRow
              icon="globe"
              label={t("Push server")}
              value={
                native.failure
                  ? t("Registration failed")
                  : (native.endpointHost ?? t("Waiting for the push server…"))
              }
            />
          </>
        ) : null}
        {native.enabled && step !== "install-distributor" && native.failure ? (
          <SettingsRow
            icon="arrow.clockwise"
            label={t("Try again")}
            onPress={() => chooseUnifiedPushDistributor(native.distributor ?? "")}
          />
        ) : null}
      </SettingsSection>
      {native.enabled && step === "ready"
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

function failureText(failure: PushFailureKind | undefined, t: Translator): string {
  switch (failure) {
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
  readonly environment: EnvironmentPushStatus;
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
    <SettingsSection title={environment.label || t("Environment")}>
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
