// fork: self-hosted devices (design Q11). Desktop only, in Settings → Sharing & access: join your own
// server with an invite, see its computers and phones, invite and remove devices. The older
// public-address and tunnel-command rows live under Advanced.
import { useAtomValue } from "@effect/atom-react";
import type { Translator } from "@t3tools/client-runtime/i18n";
import {
  DeviceKeysError,
  type DeviceListEntry,
  type DevicesStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { MonitorIcon, SmartphoneIcon, ChevronRightIcon } from "lucide-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { readInvite } from "@t3tools/client-runtime/fork/deviceKeys/inviteReading";
import { useState, useSyncExternalStore } from "react";

import {
  currentTimeMs,
  describeDevicesError,
  describeInviteProblem,
  describeServerNotice,
  describeVisibilityDetail,
  describeVisibilityShort,
  deviceSeesThisComputer,
  inviteDeadlineLabel,
  serverNotice,
  serverNoticeWindow,
  visibilityLimited,
} from "~/fork/deviceKeysLogic";
import { deviceEnvironmentIndex, peerWait } from "~/fork/deviceKeysRuntime";
import {
  devicesCommands,
  devicesSnapshot,
  devicesStatus,
  refreshDevicesStatus,
  useDeviceInviteRequests,
} from "~/fork/deviceKeysStore";
import { useT, useUiLocale } from "~/hooks/useT";
import { useClockWindowStart } from "./useClockWindow";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRelativeTimeState } from "~/hooks/useRelativeTimeState";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { QRCodeSvg } from "../components/ui/qr-code";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { SelfHostSettings } from "../components/settings/SelfHostSettings";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { SettingsRow } from "../components/settings/settingsLayout";
import { VisibilityMark } from "./VisibilityMark";
import { VisibilityRow } from "./YourServerVisibility";

const isDeviceKeysError = Schema.is(DeviceKeysError);

/** The default name offered for this computer; the user can change it before joining. */
// A device name the user keeps or edits; it is stored as typed, so it is not translated.
const defaultDeviceName = (): string => {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  // oxlint-disable-next-line t3code/no-untranslated-copy -- stored device name
  if (/mac/i.test(platform)) return "Mac";
  if (/win/i.test(platform)) return "PC";
  // oxlint-disable-next-line t3code/no-untranslated-copy -- stored device name
  return "Computer";
};

const failureMessage = (t: Translator, cause: unknown): string => {
  const error = isDeviceKeysError(cause) ? cause : null;
  return error !== null ? describeDevicesError(t, error) : t("Something went wrong. Try again.");
};

export function YourServerSettings() {
  // The devices RPCs answer the desktop app's own session only, so a browser shows the old rows.
  if (typeof window === "undefined" || window.desktopBridge === undefined) {
    return <SelfHostSettings />;
  }
  return <DesktopDevices />;
}

function DesktopDevices() {
  const t = useT();
  const environmentId = usePrimaryEnvironmentId();
  return (
    <>
      {environmentId === null ? null : <DevicesRows environmentId={environmentId} />}
      <details className="group px-3 sm:px-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          {t("Advanced")}
          <ChevronRightIcon
            aria-hidden
            className="size-3 text-muted-foreground group-open:rotate-90"
          />
        </summary>
        <SelfHostSettings />
      </details>
    </>
  );
}

function DevicesRows({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const setting = useSearchableSetting();
  const t = useT();
  const statusResult = useAtomValue(devicesStatus({ environmentId, input: {} }));
  const snapshot = Option.getOrNull(
    AsyncResult.value(useAtomValue(devicesSnapshot({ environmentId, input: {} }))),
  );
  // The server pushes status with every change, but the one-shot status is only re-read after a
  // join or leave here. A removal, or a change from the CLI, shows up in the pushed one first.
  const status = snapshot?.status ?? Option.getOrNull(AsyncResult.value(statusResult));
  const [joinOpen, setJoinOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const inviteRequests = useDeviceInviteRequests();
  const [handledRequests, setHandledRequests] = useState(0);
  // The command palette asked for an invite: open the dialog that fits where this computer stands.
  if (status !== null && inviteRequests !== handledRequests) {
    setHandledRequests(inviteRequests);
    if (status.state === "joined") setInviteOpen(true);
    else setJoinOpen(true);
  }

  if (status === null) {
    return AsyncResult.isFailure(statusResult) ? (
      <SettingsRow
        {...setting("your-server")}
        title={t("Your server")}
        description={t("Devices on your own server could not be loaded.")}
      />
    ) : null;
  }

  if (status.state !== "joined") {
    return (
      <>
        <SettingsRow
          {...setting("your-server")}
          title={t("Your server")}
          description={t(
            "Connect your computers and phones through a server you run yourself. You need an invite from a computer that has already joined.",
          )}
          status={
            status.state === "removed" ? (
              <span className="block text-warning-foreground">
                {t("This computer was removed from your server.")}
              </span>
            ) : null
          }
          control={
            <Button size="sm" onClick={() => setJoinOpen(true)}>
              {t("Join my server")}
            </Button>
          }
        />
        <JoinDialog
          environmentId={environmentId}
          open={joinOpen}
          onOpenChange={setJoinOpen}
          onJoined={() => refreshDevicesStatus(environmentId)}
        />
      </>
    );
  }

  return (
    <>
      <JoinedRows
        environmentId={environmentId}
        status={status}
        devices={snapshot?.devices ?? []}
        onInvite={() => setInviteOpen(true)}
      />
      <InviteDialog environmentId={environmentId} open={inviteOpen} onOpenChange={setInviteOpen} />
    </>
  );
}

function JoinedRows({
  environmentId,
  status: current,
  devices: listed,
  onInvite,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: DevicesStatus;
  readonly devices: ReadonlyArray<DeviceListEntry>;
  readonly onInvite: () => void;
}) {
  const setting = useSearchableSetting();
  const t = useT();
  // Re-evaluated at the moments the notice changes, so an open page shows it without a re-render.
  const noticeAt = useClockWindowStart((nowMs) => serverNoticeWindow(current, nowMs));
  const notice = serverNotice(current, noticeAt);
  const [removing, setRemoving] = useState<DeviceListEntry | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [pendingComputers, setPendingComputers] = useState<{
    readonly name: string;
    readonly computers: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  } | null>(null);
  const waiting = useWaitingDeviceIds();

  const devices = [...listed].toSorted(
    (a, b) =>
      Number(b.self) - Number(a.self) ||
      Number(a.kind === "phone") - Number(b.kind === "phone") ||
      a.name.localeCompare(b.name),
  );

  return (
    <>
      <SettingsRow
        {...setting("your-server")}
        title={t("Your server")}
        description={t("Connected to {host}.", { host: current.registryHost ?? "" })}
        status={
          <span className="flex flex-col gap-1">
            {notice === null ? null : (
              <span className="block text-warning-foreground" role="status">
                {describeServerNotice(t, notice)}
              </span>
            )}
            {current.url === null ? null : (
              <span className="block break-all">
                {t("This computer: {url}", { url: current.url })}
              </span>
            )}
            <TunnelLine tunnel={current.tunnel} />
          </span>
        }
        control={
          <Button size="sm" variant="outline" onClick={() => setLeaving(true)}>
            {t("Leave this server")}
          </Button>
        }
      >
        {devices.length === 0 ? null : (
          <ul className="mt-3 mb-2 divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60 bg-background/50">
            {devices.map((device) => (
              <DeviceItem
                key={device.id}
                device={device}
                waiting={waiting.has(device.id)}
                visibility={current.visibility}
                devices={listed}
                onRemove={() => setRemoving(device)}
              />
            ))}
          </ul>
        )}
      </SettingsRow>
      <SettingsRow
        id="devices-invite"
        title={t("Add a device")}
        description={t("Create a one-time invite for a computer or a phone.")}
        control={
          <Button size="sm" onClick={onInvite}>
            {t("Invite a device")}
          </Button>
        }
      />
      <VisibilityRow environmentId={environmentId} status={current} devices={listed} />
      <RemoveDialog
        environmentId={environmentId}
        device={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(name, computers) => {
          setRemoving(null);
          if (computers.length > 0) setPendingComputers({ name, computers });
        }}
      />
      <LeaveDialog
        environmentId={environmentId}
        open={leaving}
        onOpenChange={setLeaving}
        onLeft={() => refreshDevicesStatus(environmentId)}
      />
      <Dialog
        open={pendingComputers !== null}
        onOpenChange={(open) => {
          if (!open) setPendingComputers(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Removed {name}", { name: pendingComputers?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {t(
                "These computers have not reached your server since. They sign this device out once they do.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul className="space-y-1 text-sm">
              {pendingComputers?.computers.map((computer) => (
                <li key={computer.id}>{computer.name}</li>
              ))}
            </ul>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={() => setPendingComputers(null)}>
              {t("Done")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

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

function TunnelLine({ tunnel }: { readonly tunnel: DevicesStatus["tunnel"] }) {
  const t = useT();
  if (tunnel.status === "disabled") return null;
  const label =
    tunnel.status === "connected"
      ? t("Reachable from outside")
      : tunnel.status === "connecting"
        ? t("Connecting to your server")
        : tunnel.status === "error"
          ? t("Not reachable from outside")
          : t("Not connected");
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge
        variant={
          tunnel.status === "connected"
            ? "success"
            : tunnel.status === "connecting"
              ? "info"
              : tunnel.status === "error"
                ? "warning"
                : "outline"
        }
        size="sm"
        data-t3x-han-text
      >
        {label}
      </Badge>
      {tunnel.status === "error" && tunnel.lastError !== null ? (
        <span className="break-all text-destructive">{tunnel.lastError}</span>
      ) : null}
    </span>
  );
}

function DeviceItem({
  device,
  waiting,
  visibility,
  devices,
  onRemove,
}: {
  readonly device: DeviceListEntry;
  readonly waiting: boolean;
  readonly visibility: DevicesStatus["visibility"];
  readonly devices: ReadonlyArray<DeviceListEntry>;
  readonly onRemove: () => void;
}) {
  const t = useT();
  const Icon = device.kind === "phone" ? SmartphoneIcon : MonitorIcon;
  const seen = useRelativeTimeState(new Date(device.lastSeenAt * 1000).toISOString());
  const lastSeen = seen.status === "relative" ? seen.label : "";
  return (
    <li className="flex min-h-11 items-center gap-2.5 py-1.5 pr-2 pl-3">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{device.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {waiting ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner size="sm" />
              {t("Waiting for that computer to confirm…")}
            </span>
          ) : device.self ? (
            t("This computer")
          ) : device.kind === "phone" ? (
            t("Phone · seen {time}", { time: lastSeen })
          ) : (
            t("Computer · seen {time}", { time: lastSeen })
          )}
        </span>
      </span>
      {visibility === undefined || !visibilityLimited(visibility) ? null : device.self ? (
        <VisibilityMark
          label={describeVisibilityShort(t, visibility, devices)}
          tooltip={describeVisibilityDetail(t, visibility, devices)}
          className="min-w-0 max-w-[45%]"
        />
      ) : deviceSeesThisComputer(visibility, device.id) ? null : (
        <VisibilityMark
          label={t("Can't see this computer")}
          tooltip={t("Your Visibility setting hides this computer from {name}.", {
            name: device.name,
          })}
        />
      )}
      {device.kind === "computer" && !device.self && device.online !== undefined ? (
        <Badge variant={device.online ? "success" : "outline"} size="sm" data-t3x-han-text>
          {device.online ? t("Online") : t("Offline")}
        </Badge>
      ) : null}
      {device.self ? null : (
        <Button
          size="xs"
          variant="destructive-outline"
          aria-label={t("Remove {name}", { name: device.name })}
          onClick={onRemove}
        >
          {t("Remove")}
        </Button>
      )}
    </li>
  );
}

function JoinDialog({
  environmentId,
  open,
  onOpenChange,
  onJoined,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onJoined: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <JoinForm environmentId={environmentId} onClose={onOpenChange} onJoined={onJoined} />
      </DialogPopup>
    </Dialog>
  );
}

function JoinForm({
  environmentId,
  onClose,
  onJoined,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: (open: boolean) => void;
  readonly onJoined: () => void;
}) {
  const t = useT();
  const join = useAtomCommand(devicesCommands.join, { reportFailure: false });
  const [invite, setInvite] = useState("");
  const [name, setName] = useState(defaultDeviceName);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reading = readInvite(invite, currentTimeMs());
  const problem =
    reading._tag === "invalid" || reading._tag === "expired" || reading._tag === "wrong-kind";

  const submit = async () => {
    setPending(true);
    setError(null);
    const result = await join({
      environmentId,
      input: { invite: invite.trim(), name: name.trim() },
    });
    setPending(false);
    if (result._tag === "Success") {
      onJoined();
      onClose(false);
      return;
    }
    setConfirming(false);
    setError(failureMessage(t, squashAtomCommandFailure(result)));
  };

  if (confirming && reading._tag === "ready") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("Join {host}?", { host: reading.host })}</DialogTitle>
          <DialogDescription>
            {t("Is this your own server? Only join a server you set up yourself.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <p className="break-all font-mono text-sm text-foreground">{reading.host}</p>
            {reading.punycode === null ? null : (
              <p className="break-all text-xs text-muted-foreground">
                {t("Written with other letters. As an address: {address}", {
                  address: reading.punycode,
                })}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
            {t("Back")}
          </Button>
          <Button disabled={pending} onClick={() => void submit()}>
            {pending ? <Spinner size="sm" /> : null}
            {t("Join {host}", { host: reading.host })}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Join my server")}</DialogTitle>
        <DialogDescription>
          {t("Paste the invite from a computer that has already joined. Nothing is sent yet.")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3">
          <Textarea
            value={invite}
            rows={3}
            spellCheck={false}
            placeholder="t3x1.…"
            aria-label={t("Invite")}
            aria-invalid={problem}
            onChange={(event) => {
              setInvite(event.target.value);
              setError(null);
            }}
          />
          {problem ? (
            <p className="text-xs text-destructive">{describeInviteProblem(t, reading)}</p>
          ) : null}
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">{t("Name of this computer")}</span>
            <Input
              size="sm"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={() => onClose(false)}>
          {t("Cancel")}
        </Button>
        <Button
          disabled={reading._tag !== "ready" || name.trim() === ""}
          onClick={() => setConfirming(true)}
        >
          {t("Continue")}
        </Button>
      </DialogFooter>
    </>
  );
}

function InviteDialog({
  environmentId,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <InviteForm environmentId={environmentId} onClose={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}

function InviteForm({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const t = useT();
  const locale = useUiLocale();
  const createInvite = useAtomCommand(devicesCommands.invite, { reportFailure: false });
  const cancelInvite = useAtomCommand(devicesCommands.cancelInvite, { reportFailure: false });
  const [kind, setKind] = useState<"computer" | "phone">("phone");
  const [created, setCreated] = useState<{
    readonly id: string;
    readonly invite: string;
    readonly expiresAt: number;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setPending(true);
    setError(null);
    const result = await createInvite({ environmentId, input: { kind } });
    setPending(false);
    if (result._tag === "Success") setCreated(result.value);
    else setError(failureMessage(t, squashAtomCommandFailure(result)));
  };
  const cancel = async () => {
    if (created === null) return;
    setPending(true);
    const result = await cancelInvite({ environmentId, input: { id: created.id } });
    setPending(false);
    if (result._tag === "Success") onClose();
    else setError(failureMessage(t, squashAtomCommandFailure(result)));
  };
  const copy = () => {
    if (created === null) return;
    void navigator.clipboard.writeText(created.invite).then(() => setCopied(true));
  };

  if (created === null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("Invite a device")}</DialogTitle>
          <DialogDescription>
            {t("An invite works once and expires after 15 minutes. Treat it like a password.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <ToggleGroup
              aria-label={t("Kind of device")}
              variant="segmented"
              value={[kind]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "computer" || value === "phone") setKind(value);
              }}
            >
              <Toggle value="phone">{t("Phone")}</Toggle>
              <Toggle value="computer">{t("Computer")}</Toggle>
            </ToggleGroup>
            {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={pending} onClick={() => void create()}>
            {pending ? <Spinner size="sm" /> : null}
            {t("Create invite")}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{kind === "phone" ? t("Invite a phone") : t("Invite a computer")}</DialogTitle>
        <DialogDescription>
          {kind === "phone"
            ? t("Scan the code in the app, or paste the invite. Valid until {time}.", {
                time: inviteDeadlineLabel(created.expiresAt, locale),
              })
            : t("Paste the invite in Settings on the other computer. Valid until {time}.", {
                time: inviteDeadlineLabel(created.expiresAt, locale),
              })}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3">
          <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
            <QRCodeSvg
              value={created.invite}
              size={176}
              level="M"
              marginSize={2}
              title={t("Invite. Scan to join your server")}
            />
          </div>
          <Textarea
            readOnly
            value={created.invite}
            rows={3}
            aria-label={t("Invite")}
            onFocus={(event) => event.currentTarget.select()}
          />
          {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="destructive-outline" disabled={pending} onClick={() => void cancel()}>
          {t("Cancel invite")}
        </Button>
        <Button variant="outline" onClick={copy}>
          {copied ? t("Copied") : t("Copy invite")}
        </Button>
        <Button onClick={onClose}>{t("Done")}</Button>
      </DialogFooter>
    </>
  );
}

function RemoveDialog({
  environmentId,
  device,
  onClose,
  onRemoved,
}: {
  readonly environmentId: EnvironmentId;
  readonly device: DeviceListEntry | null;
  readonly onClose: () => void;
  readonly onRemoved: (
    name: string,
    pendingComputers: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  ) => void;
}) {
  const t = useT();
  const remove = useAtomCommand(devicesCommands.remove, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<DeviceListEntry | null>(device);
  if (device !== null && shown !== device) setShown(device);
  const target = device ?? shown;

  const submit = async () => {
    if (device === null) return;
    setPending(true);
    setError(null);
    const result = await remove({ environmentId, input: { deviceId: device.id } });
    setPending(false);
    if (result._tag === "Success") onRemoved(device.name, result.value.pendingComputers);
    else setError(failureMessage(t, squashAtomCommandFailure(result)));
  };

  return (
    <AlertDialog
      open={device !== null}
      onOpenChange={(open) => {
        if (pending) return;
        if (!open) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Remove {name}?", { name: target?.name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "It can no longer sign in to your computers. Computers that cannot reach your server right now sign it out when they can.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : <p className="px-6 pb-4 text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
            {t("Cancel")}
          </AlertDialogClose>
          <Button variant="destructive" disabled={pending} onClick={() => void submit()}>
            {pending ? <Spinner size="sm" /> : null}
            {t("Remove")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function LeaveDialog({
  environmentId,
  open,
  onOpenChange,
  onLeft,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onLeft: () => void;
}) {
  const t = useT();
  const leave = useAtomCommand(devicesCommands.leave, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    const result = await leave({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Success") {
      onLeft();
      onOpenChange(false);
    } else {
      setError(failureMessage(t, squashAtomCommandFailure(result)));
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Leave your server?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "This computer is removed from the list and forgets its key. Other devices can no longer sign in to it through your server. You can join again with a new invite.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : <p className="px-6 pb-4 text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
            {t("Cancel")}
          </AlertDialogClose>
          <Button variant="destructive" disabled={pending} onClick={() => void submit()}>
            {pending ? <Spinner size="sm" /> : null}
            {t("Leave")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
