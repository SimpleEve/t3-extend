// fork: the phone's page for the server it joined (design Q11): join with an invite, see the
// devices, leave. Read-only on purpose: a phone never invites or removes (the registry refuses it).
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { useRef, useState, useSyncExternalStore } from "react";
import { Modal, View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { readInvite } from "@t3tools/client-runtime/fork/deviceKeys/inviteReading";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../../features/settings/components/SettingsScreen";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { useNowMinuteMs } from "../../lib/clock";
import { useT } from "../../hooks/useT";
import { deviceEnvironmentIndex, peerWait } from "./deviceKeysRuntime";
import { deviceSync, useDeviceSyncState } from "./deviceKeysStore";
import {
  describeDevice,
  describeInviteProblem,
  describeJoinFailure,
  serverNotice,
} from "./serverDevicesPresentation";

const hostOf = (origin: string) => new URL(origin).host;

function useWaitingDeviceIds(): ReadonlySet<string> {
  const environments = useSyncExternalStore(
    peerWait.subscribe,
    peerWait.snapshot,
    peerWait.snapshot,
  );
  return new Set(
    [...environments].flatMap((environmentId) => {
      const deviceId = deviceEnvironmentIndex.get(environmentId);
      return deviceId === undefined ? [] : [deviceId];
    }),
  );
}

export function ServerDevicesScreen() {
  const t = useT();
  const insets = useSafeAreaInsets();
  const state = useDeviceSyncState();
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const busy = useRef(false);

  const join = (text: string) => {
    if (busy.current) return;
    busy.current = true;
    void deviceSync
      .join(text, Device.deviceName ?? Device.modelName ?? "Phone")
      .then((result) => {
        if (!result.ok) Dialog.alert(t("Can't join"), describeJoinFailure(t, result.failure));
      })
      .finally(() => {
        busy.current = false;
      });
  };

  // Nothing leaves the phone until the user has seen which server the invite names and agreed.
  const confirmJoin = (text: string) => {
    const reading = readInvite(text, Date.now(), "phone");
    if (reading._tag !== "ready") {
      Dialog.alert(t("Can't join"), describeInviteProblem(t, reading));
      return;
    }
    const warning = t("Is this your own server? Only join a server you set up yourself.");
    Dialog.confirm({
      title: t("Join {host}?", { host: reading.host }),
      message:
        reading.punycode === null
          ? warning
          : `${warning}\n${t("Written with other letters. As an address: {address}", { address: reading.punycode })}`,
      confirmText: t("Join {host}", { host: reading.host }),
      cancelText: t("Cancel"),
      onConfirm: () => join(text),
    });
  };

  const pasteInvite = () =>
    Dialog.prompt({
      title: t("Join your server"),
      message: t("Paste the invite from a computer that has already joined. Nothing is sent yet."),
      initialValue: "",
      confirmText: t("Continue"),
      cancelText: t("Cancel"),
      onConfirm: confirmJoin,
    });

  const leave = () =>
    Dialog.confirm({
      title: t("Leave your server?"),
      message: t(
        "This phone forgets its key and the computers saved from your server. You can join again with a new invite.",
      ),
      confirmText: t("Leave"),
      cancelText: t("Cancel"),
      destructive: true,
      onConfirm: () => void deviceSync.leave(),
    });

  const refresh = () => {
    setRefreshing(true);
    void deviceSync.refresh({ force: true }).finally(() => setRefreshing(false));
  };

  return (
    <SettingsScreen title={t("Your server")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          state._tag === "joined" ? (
            <RefreshControl refreshing={refreshing} onRefresh={refresh} />
          ) : undefined
        }
      >
        {state._tag === "joined" ? (
          <JoinedServer state={state} onLeave={leave} />
        ) : state._tag === "not-joined" ? (
          <>
            {state.removed ? (
              <Notice message={t("This phone was removed from your server.")} tone="danger" />
            ) : null}
            <SettingsSection
              title={t("Your server")}
              footer={t(
                "Connect your computers and phones through a server you run yourself. You need an invite from a computer that has already joined.",
              )}
            >
              <ListActionRow
                icon="qrcode.viewfinder"
                label={t("Scan QR code")}
                onPress={() => setScanning(true)}
              />
              <ListActionRow icon="keyboard" label={t("Paste invite")} onPress={pasteInvite} />
            </SettingsSection>
          </>
        ) : state._tag === "damaged" ? (
          <SettingsSection
            title={t("Your server")}
            footer={t(
              "The device key on this phone cannot be read. Leave this server and join again with a new invite.",
            )}
          >
            <ListActionRow
              icon="person.fill.xmark"
              label={t("Leave this server")}
              tone="danger"
              onPress={leave}
            />
          </SettingsSection>
        ) : state._tag === "storage-error" ? (
          <Notice
            message={t("This phone's secure storage did not answer. Try again in a moment.")}
            tone="danger"
          />
        ) : null}
      </ScrollView>
      <InviteScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onScan={(text) => {
          setScanning(false);
          confirmJoin(text);
        }}
      />
    </SettingsScreen>
  );
}

function JoinedServer({
  state,
  onLeave,
}: {
  readonly state: Extract<ReturnType<typeof useDeviceSyncState>, { _tag: "joined" }>;
  readonly onLeave: () => void;
}) {
  const t = useT();
  const waiting = useWaitingDeviceIds();
  // Upstream's minute clock: the labels below change at most once a minute.
  const nowMs = useNowMinuteMs();
  const notice = serverNotice(t, state, nowMs);
  return (
    <>
      {notice === null ? null : <Notice message={notice} icon="exclamationmark.triangle" />}
      <SettingsSection
        title={t("Your server")}
        footer={t("Connected to {host}.", { host: hostOf(state.membership.origin) })}
      >
        {state.devices.map((device) => (
          <ListRowLayout
            key={device.id}
            icon={device.kind === "phone" ? "iphone" : "desktopcomputer"}
            label={
              device.id === state.membership.deviceId
                ? t("{name} (this phone)", { name: device.name })
                : device.name
            }
            description={describeDevice(t, device, { waiting: waiting.has(device.id), nowMs })}
          />
        ))}
      </SettingsSection>
      <SettingsSection>
        <ListActionRow
          icon="person.fill.xmark"
          label={t("Leave this server")}
          tone="danger"
          onPress={onLeave}
        />
      </SettingsSection>
    </>
  );
}

function InviteScanner(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onScan: (text: string) => void;
}) {
  const t = useT();
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      onRequestClose={props.onClose}
      onShow={() => {
        scanned.current = false;
      }}
    >
      <View className="flex-1 bg-black">
        {permission?.granted ? (
          <CameraView
            active={props.visible}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(result) => {
              if (scanned.current) return;
              scanned.current = true;
              props.onScan(result.data);
            }}
            style={{ flex: 1 }}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-4 px-8">
            <Text className="text-center text-white">
              {t("Camera access is needed to scan the code.")}
            </Text>
            <ListActionRow label={t("Allow camera")} onPress={() => void requestPermission()} />
          </View>
        )}
        <View className="absolute inset-x-0 bottom-0 gap-3 p-6">
          <Text className="text-center text-white">
            {t("Scan the code shown by a computer that has already joined.")}
          </Text>
          <ListActionRow label={t("Close")} onPress={props.onClose} />
        </View>
      </View>
    </Modal>
  );
}
