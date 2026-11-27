// fork: pure decisions behind the Devices section of Settings (design Q11), kept apart from React
// so the rules that matter, which warning shows and what the invite dialog asks, are tested alone.
import type { DeviceDirectoryView } from "@t3tools/client-runtime/fork/deviceKeys/discovery";
import type {
  DeviceKeysError,
  DeviceListEntry,
  DevicesSnapshot,
  DevicesStatus,
  DeviceVisibility,
} from "@t3tools/contracts";
import type { Translator } from "@t3tools/client-runtime/i18n";

import type { ClockWindow } from "./useClockWindow";
import type { InviteReading } from "@t3tools/client-runtime/fork/deviceKeys/inviteReading";

/** The clock for checks that only need the moment of a click or a keystroke, not a live label. */
export const currentTimeMs = () => Date.now();

/** The registry list is fetched every minute; three missed rounds is a server that is not answering. */
const UNREACHABLE_AFTER_SECONDS = 180;

export type ServerNotice =
  | { readonly kind: "unreachable"; readonly minutes: number }
  | { readonly kind: "stale"; readonly hours: number }
  | { readonly kind: "expired" }
  | { readonly kind: "no-list" };

/**
 * What the top of the section says about the link to the user's server. `staleness` only turns
 * from fresh after a day, so the last sync time carries the first three minutes to a day: a list
 * that is fresh by that measure can still be minutes old.
 */
export function serverNotice(
  status: Pick<DevicesStatus, "fetchedAt" | "staleness">,
  nowMs: number,
): ServerNotice | null {
  if (status.staleness === "expired") return { kind: "expired" };
  if (status.staleness === "unavailable" || status.fetchedAt === null) return { kind: "no-list" };
  const ageSeconds = Math.max(0, Math.floor(nowMs / 1000 - status.fetchedAt));
  if (status.staleness === "warn") return { kind: "stale", hours: Math.floor(ageSeconds / 3600) };
  if (ageSeconds >= UNREACHABLE_AFTER_SECONDS) {
    return { kind: "unreachable", minutes: Math.floor(ageSeconds / 60) };
  }
  return null;
}

type TunnelState = DevicesStatus["tunnel"]["status"];

/**
 * Whether the desktop app's pairing addresses changed when the tunnel moved from `previous` to
 * `next`: they exist while joined (not "disabled") and count as available while "connected". The
 * server writes their files before it reports the status, so the status is the signal, not the snapshot's URL.
 */
export function networkAccessNeedsRefresh(
  previous: TunnelState | null,
  next: TunnelState,
): boolean {
  return (
    previous !== null &&
    ((previous === "disabled") !== (next === "disabled") ||
      (previous === "connected") !== (next === "connected"))
  );
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Where `nowMs` sits among the moments `serverNotice` changes: three minutes after the last sync,
 * then every minute (every hour once the list is a day old). `serverNotice(status, window.startMs)`
 * reads the same as at `nowMs`.
 */
export function serverNoticeWindow(
  status: Pick<DevicesStatus, "fetchedAt" | "staleness">,
  nowMs: number,
): ClockWindow {
  if (
    status.staleness === "expired" ||
    status.staleness === "unavailable" ||
    status.fetchedAt === null
  ) {
    return { startMs: 0, endMs: null };
  }
  const syncedMs = status.fetchedAt * 1000;
  const elapsedMs = Math.max(0, nowMs - syncedMs);
  if (status.staleness !== "warn" && elapsedMs < UNREACHABLE_AFTER_SECONDS * 1000) {
    return { startMs: syncedMs, endMs: syncedMs + UNREACHABLE_AFTER_SECONDS * 1000 };
  }
  const unitMs = status.staleness === "warn" ? HOUR_MS : MINUTE_MS;
  const startMs = syncedMs + Math.floor(elapsedMs / unitMs) * unitMs;
  return { startMs, endMs: startMs + unitMs };
}

export function describeServerNotice(t: Translator, notice: ServerNotice): string {
  switch (notice.kind) {
    case "unreachable":
      return t("Can't reach your server right now. Last synced {minutes} minutes ago.", {
        minutes: notice.minutes,
      });
    case "stale":
      return t(
        "This computer has not reached your server for {hours} hours. After 7 days it stops accepting new devices.",
        { hours: notice.hours },
      );
    case "expired":
      return t(
        "This computer has not reached your server for over 7 days, so it no longer accepts new devices.",
      );
    case "no-list":
      return t("This computer has not received the device list from your server yet.");
  }
}

/** "Valid until 01:14": an absolute, zero-padded 24-hour time, so the dialog needs no ticking clock. */
export function inviteDeadlineLabel(expiresAtSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(expiresAtSeconds * 1000));
}

export function describeInviteProblem(
  t: Translator,
  reading: Exclude<InviteReading, { readonly _tag: "ready" | "empty" }>,
): string {
  switch (reading._tag) {
    case "invalid":
      return t("That is not an invite from your server.");
    case "expired":
      return t("This invite has expired. Create a new one on a computer that is already joined.");
    case "wrong-kind":
      return t("This invite is for a phone. Create one for a computer to join here.");
  }
}

export function describeDevicesError(t: Translator, error: DeviceKeysError): string {
  switch (error.reason) {
    case "not_local_owner":
      return t("Only this computer's own app can manage devices.");
    case "not_joined":
      return t("This computer has not joined a server.");
    case "already_joined":
      return t("This computer has already joined a server.");
    case "list_expired":
      return t("This computer has not reached your server for over 7 days.");
    case "unknown_audience":
      return t("That computer is not in your server's list.");
    case "rate_limited":
      return t("Your server asked to slow down. Try again in a moment.");
    case "invite_invalid":
      return error.registryCode === "invite_used"
        ? t("This invite has already been used.")
        : error.registryCode === "invite_expired"
          ? t("This invite has expired. Create a new one on a computer that is already joined.")
          : t("Your server did not accept this invite.");
    case "invalid_input":
      return t("That name is not allowed. Use 1 to 40 characters.");
    case "registry_unreachable":
      return t("Can't reach your server.");
    case "registry_rejected":
      return t("Your server did not accept the request.");
    case "storage":
      return t("This computer could not save the device key.");
  }
}

type VisibilityState = NonNullable<DevicesStatus["visibility"]>;

/** The two modes that name devices need at least one to mean anything different from the other two. */
export function visibilityDraftReady(draft: DeviceVisibility): boolean {
  const names = draft.mode === "hidden_from_selected" || draft.mode === "visible_to_selected";
  return !names || draft.deviceIds.length > 0;
}

/** What goes to the server: the two modes that name no devices carry no list. */
export function visibilityToSend(draft: DeviceVisibility): DeviceVisibility {
  const names = draft.mode === "hidden_from_selected" || draft.mode === "visible_to_selected";
  return { mode: draft.mode, deviceIds: names ? [...new Set(draft.deviceIds)].sort() : [] };
}

/** A device this computer cannot see is shown by the start of its id, like the CLI does. */
export const shortDeviceId = (id: string): string => `${id.slice(0, 8)}…`;

/** Whether `draft` is already what the server holds, so saving would change nothing. */
export function visibilityUnchanged(draft: DeviceVisibility, saved: VisibilityState): boolean {
  // An unreadable file is only repaired by saving, whatever the options look like.
  if (saved.unreadable === true) return false;
  const next = visibilityToSend(draft);
  const current = visibilityToSend(saved);
  return next.mode === current.mode && next.deviceIds.join() === current.deviceIds.join();
}

/** One line for the Visibility row: who can see this computer right now. */
export function describeVisibility(
  t: Translator,
  visibility: DeviceVisibility,
  devices: ReadonlyArray<Pick<DeviceListEntry, "id" | "name">>,
): string {
  // An id that is not on the list is a computer that hides from this one: it still counts.
  const names = visibility.deviceIds
    .map((id) => devices.find((device) => device.id === id)?.name ?? shortDeviceId(id))
    .join(", ");
  switch (visibility.mode) {
    case "visible_to_all":
      return t("Visible to all devices.");
    case "hidden_from_all":
      return t("Hidden from all devices, including ones that join later.");
    case "hidden_from_selected":
      return names === ""
        ? t("Hidden from the devices you chose.")
        : t("Hidden from {names}.", { names });
    case "visible_to_selected":
      return names === ""
        ? t("Visible only to the devices you chose.")
        : t("Visible only to {names}.", { names });
  }
}

/** The sentence for a tooltip: `describeVisibility`, or the refusal when the saved setting is unreadable. */
export function describeVisibilityDetail(
  t: Translator,
  visibility: Pick<VisibilityState, "mode" | "deviceIds" | "unreadable">,
  devices: ReadonlyArray<Pick<DeviceListEntry, "id" | "name">>,
): string {
  return visibility.unreadable === true
    ? t("The saved setting could not be read. Other devices are refused until you save a new one.")
    : describeVisibility(t, visibility, devices);
}

/** Whether the setting keeps this computer from anyone; the default shows no mark anywhere. */
export function visibilityLimited(visibility: Pick<VisibilityState, "mode" | "unreadable">) {
  return visibility.unreadable === true || visibility.mode !== "visible_to_all";
}

/**
 * Whether the device with `deviceId` can see this computer right now. An unreadable setting refuses
 * every other device; a device that joins later is not in the list yet, so it is not asked here.
 */
export function deviceSeesThisComputer(
  visibility: Pick<VisibilityState, "mode" | "deviceIds" | "unreadable">,
  deviceId: string,
): boolean {
  if (visibility.unreadable === true) return false;
  switch (visibility.mode) {
    case "visible_to_all":
      return true;
    case "hidden_from_all":
      return false;
    case "hidden_from_selected":
      return !visibility.deviceIds.includes(deviceId);
    case "visible_to_selected":
      return visibility.deviceIds.includes(deviceId);
  }
}

/** Names go in the label when they are few and short; otherwise a count keeps it to one line. */
const SHORT_LABEL_MAX_DEVICES = 2;
const SHORT_LABEL_MAX_NAME_CHARS = 18;

/** The active mode in a few words, for beside the Visibility title and in the device list. */
function shortLabelNames(
  deviceIds: ReadonlyArray<string>,
  devices: ReadonlyArray<Pick<DeviceListEntry, "id" | "name">>,
): string | null {
  const known = deviceIds.flatMap((id) => {
    const name = devices.find((device) => device.id === id)?.name;
    return name === undefined ? [] : [name];
  });
  // An id that is not on the list has no name worth showing, so its mode falls back to the count.
  return deviceIds.length > 0 &&
    known.length === deviceIds.length &&
    deviceIds.length <= SHORT_LABEL_MAX_DEVICES &&
    known.join(", ").length <= SHORT_LABEL_MAX_NAME_CHARS
    ? known.join(", ")
    : null;
}

/** Whether `describeVisibility` says more than `describeVisibilityShort`, so the row should show it too. */
export function visibilityDetailAddsToLabel(
  visibility: Pick<VisibilityState, "mode" | "deviceIds">,
  devices: ReadonlyArray<Pick<DeviceListEntry, "id" | "name">>,
): boolean {
  switch (visibility.mode) {
    case "visible_to_all":
      return false;
    case "hidden_from_all":
      return true;
    case "hidden_from_selected":
    case "visible_to_selected":
      return shortLabelNames(visibility.deviceIds, devices) === null;
  }
}

export function describeVisibilityShort(
  t: Translator,
  visibility: Pick<VisibilityState, "mode" | "deviceIds" | "unreadable">,
  devices: ReadonlyArray<Pick<DeviceListEntry, "id" | "name">>,
): string {
  if (visibility.unreadable === true) return t("Setting unreadable");
  const count = visibility.deviceIds.length;
  const names = shortLabelNames(visibility.deviceIds, devices);
  switch (visibility.mode) {
    case "visible_to_all":
      return t("Visible to all devices");
    case "hidden_from_all":
      return t("Hidden from all devices");
    case "hidden_from_selected":
      return names !== null
        ? t("Hidden from {names}", { names })
        : count === 1
          ? t("Hidden from {count} device", { count })
          : t("Hidden from {count} devices", { count });
    case "visible_to_selected":
      return names !== null
        ? t("Visible only to {names}", { names })
        : count === 1
          ? t("Visible only to {count} device", { count })
          : t("Visible only to {count} devices", { count });
  }
}

/** What to tell about the server's copy of the setting; null when there is nothing to say. */
export function describeVisibilityRegistry(
  t: Translator,
  registry: VisibilityState["registry"],
): string | null {
  switch (registry) {
    case "unsupported":
      return t(
        "Your server needs an update before it can hide this computer from other devices' lists. This computer already refuses the sign-ins this setting rules out.",
      );
    case "pending":
      return t(
        "Your server has not received this setting yet. This computer already applies it and keeps trying.",
      );
    case "synced":
    case "unknown":
      return null;
  }
}

export function snapshotToView(snapshot: DevicesSnapshot): DeviceDirectoryView | null {
  const { status } = snapshot;
  if (status.state !== "joined" || status.registryOrigin === null) return null;
  return {
    pin: { origin: status.registryOrigin, registryId: null },
    // The server checks the registry's record when it signs; the list it pushes does not carry it.
    recordsEnvironmentIds: false,
    computers: snapshot.devices
      .filter((device) => device.kind === "computer")
      .map((device) => ({
        deviceId: device.id,
        name: device.name,
        url: device.url ?? null,
        environmentId: null,
        self: device.self,
        ...(device.online === undefined ? {} : { online: device.online }),
      })),
  };
}
