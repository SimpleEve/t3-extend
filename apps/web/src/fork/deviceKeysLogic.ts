// fork: pure decisions behind the Devices section of Settings (design Q11), kept apart from React
// so the rules that matter, which warning shows and what the invite dialog asks, are tested alone.
import type { DeviceDirectoryView } from "@t3tools/client-runtime/fork/deviceKeys/discovery";
import type { DeviceKeysError, DevicesSnapshot, DevicesStatus } from "@t3tools/contracts";
import type { Translator } from "@t3tools/client-runtime/i18n";
import type { InviteReading } from "@t3tools/client-runtime/fork/deviceKeys/inviteReading";

/** The clock behind the notices, read at render time so the section needs no ticking timer. */
export const currentTimeMs = () => Date.now();

/** The registry list is fetched every minute; three missed rounds is a server that is not answering. */
const UNREACHABLE_AFTER_SECONDS = 180;

/**
 * The status stream pushes when the list changes, and the registry answering "no change" refreshes
 * `fetchedAt` without a push, so the stream's copy can lag behind the status the query last read.
 */
export function freshestStatus(
  streamed: DevicesStatus | undefined,
  queried: DevicesStatus,
): DevicesStatus {
  if (streamed === undefined) return queried;
  return (queried.fetchedAt ?? 0) > (streamed.fetchedAt ?? 0) ? queried : streamed;
}

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

/** "Valid until 14:32": an absolute time, so the dialog needs no ticking clock. */
export function inviteDeadlineLabel(expiresAtSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(expiresAtSeconds * 1000),
  );
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
