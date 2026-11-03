// fork: reads a pasted or scanned invite without sending anything anywhere, so the dialog can name
// the server and ask before any request leaves (design Q11, "钓鱼确认"). Shared by the desktop and the phone.
import { decodeInvite, type Invite } from "@t3tools/shared/forkDeviceKeys/invite";

export type InviteReading =
  | { readonly _tag: "empty" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "expired" }
  | { readonly _tag: "wrong-kind" }
  | {
      readonly _tag: "ready";
      readonly invite: Invite;
      /** The address as the invite spells it, shown to the user for confirmation. */
      readonly host: string;
      /** The ASCII form of the same name, shown beside it when the two differ. */
      readonly punycode: string | null;
    };

const hostOfOrigin = (origin: string): { host: string; punycode: string | null } | null => {
  let ascii: string;
  try {
    const url = new URL(origin);
    // The server insists on a bare https origin, so anything else is not worth confirming.
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.username !== ""
    ) {
      return null;
    }
    ascii = url.hostname;
  } catch {
    return null;
  }
  const spelled = /^https:\/\/([^/:?#@]+)/i.exec(origin.normalize("NFC"))?.[1]?.toLowerCase();
  const host = spelled ?? ascii;
  return { host, punycode: host === ascii ? null : ascii };
};

/** `joining` is what the reader is: an invite made for the other kind is refused. */
export function readInvite(
  text: string,
  nowMs: number,
  joining: "computer" | "phone" = "computer",
): InviteReading {
  const trimmed = text.trim();
  if (trimmed === "") return { _tag: "empty" };
  const invite = decodeInvite(trimmed);
  if (invite === null) return { _tag: "invalid" };
  if (invite.kind !== "any" && invite.kind !== joining) return { _tag: "wrong-kind" };
  if (invite.expiresAt * 1000 <= nowMs) return { _tag: "expired" };
  const named = hostOfOrigin(invite.origin);
  if (named === null) return { _tag: "invalid" };
  return { _tag: "ready", invite, ...named };
}
