// fork: the words and small decisions of the phone's "Your server" page, apart from React so they
// are tested alone (design Q11).
import type { RegistryDevice } from "@t3tools/contracts";
import type { Translator } from "@t3tools/client-runtime/i18n";
import type { InviteReading } from "@t3tools/client-runtime/fork/deviceKeys/inviteReading";

import { relativeTime } from "../../lib/time";
import type { DeviceSyncState, JoinFailure } from "./deviceSync";

export function describeJoinFailure(t: Translator, failure: JoinFailure): string {
  switch (failure) {
    case "invalid":
      return t("That is not an invite from your server.");
    case "expired":
    case "invite-expired":
      return t("This invite has expired. Create a new one on a computer that is already joined.");
    case "wrong-kind":
      return t("This invite is for a computer. Create one for a phone to join here.");
    case "already-joined":
      return t("This phone has already joined a server.");
    case "name-invalid":
      return t("That name is not allowed. Use 1 to 40 characters.");
    case "invite-used":
      return t("This invite has already been used.");
    case "invite-invalid":
      return t("Your server did not accept this invite.");
    case "rate-limited":
      return t("Your server asked to slow down. Try again in a moment.");
    case "unreachable":
      return t("Can't reach your server.");
    case "wrong-server":
      return t("The server at that address is not the one this invite was made for.");
    case "storage":
      return t("This phone could not save its device key.");
  }
}

export function describeInviteProblem(
  t: Translator,
  reading: Exclude<InviteReading, { readonly _tag: "ready" }>,
): string {
  return describeJoinFailure(t, reading._tag === "empty" ? "invalid" : reading._tag);
}

/** What the top of the joined page says about the link to the server, or null while it is fine. */
export function serverNotice(
  t: Translator,
  state: Extract<DeviceSyncState, { _tag: "joined" }>,
  nowMs: number,
): string | null {
  if (!state.unreachable) return null;
  if (state.fetchedAt === null) return t("Can't reach your server right now.");
  const minutes = Math.max(0, Math.floor((nowMs - state.fetchedAt * 1000) / 60_000));
  return t("Can't reach your server right now. Last synced {minutes} minutes ago.", { minutes });
}

/** A device's second line: waiting for its peer, or what kind it is and when it was last seen. */
export function describeDevice(
  t: Translator,
  device: RegistryDevice,
  options: { readonly waiting: boolean; readonly nowMs: number },
): string {
  if (options.waiting) return t("Waiting for that computer to confirm…");
  if (device.kind === "computer" && device.online === true) return t("Computer · online");
  const time = relativeTime(new Date(device.lastSeenAt * 1000).toISOString(), options.nowMs);
  return device.kind === "phone"
    ? t("Phone · seen {time}", { time })
    : t("Computer · seen {time}", { time });
}
