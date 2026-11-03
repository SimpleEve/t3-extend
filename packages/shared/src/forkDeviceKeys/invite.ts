// fork: invite strings, "t3x1." + base64url(JSON) (design 3.2 / Q9). Mirrors registry/invites.mjs.
import * as Schema from "effect/Schema";

import { b64u } from "./jws.ts";

export const INVITE_PREFIX = "t3x1.";
const INVITE_ID = /^[A-Za-z0-9_-]{11}$/;
const INVITE_SECRET = /^[A-Za-z0-9_-]{22}$/;
const REGISTRY_ID = /^[a-z2-7]{8}$/;

export type InviteKind = "computer" | "phone" | "any";
const CODE_TO_KIND: Readonly<Record<string, InviteKind>> = { c: "computer", p: "phone", a: "any" };
const KIND_TO_CODE: Readonly<Record<InviteKind, string>> = { computer: "c", phone: "p", any: "a" };

export interface Invite {
  readonly origin: string;
  readonly registryId: string;
  readonly id: string;
  readonly secret: string;
  readonly kind: InviteKind;
  readonly expiresAt: number;
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const encodeInvite = (invite: Invite): string =>
  `${INVITE_PREFIX}${b64u.encode(
    encodeJson({
      v: 1,
      o: invite.origin,
      r: invite.registryId,
      i: invite.id,
      s: invite.secret,
      k: KIND_TO_CODE[invite.kind],
      e: invite.expiresAt,
    }),
  )}`;

/** Strict parse; null for anything that is not a version-1 invite. */
export const decodeInvite = (text: unknown): Invite | null => {
  if (typeof text !== "string" || !text.startsWith(INVITE_PREFIX)) return null;
  const bytes = b64u.decode(text.slice(INVITE_PREFIX.length));
  if (bytes === null) return null;
  let payload: unknown;
  try {
    payload = decodeJson(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const kind = typeof p.k === "string" ? CODE_TO_KIND[p.k] : undefined;
  if (
    p.v !== 1 ||
    typeof p.o !== "string" ||
    p.o.length > 80 ||
    typeof p.r !== "string" ||
    !REGISTRY_ID.test(p.r) ||
    typeof p.i !== "string" ||
    !INVITE_ID.test(p.i) ||
    typeof p.s !== "string" ||
    !INVITE_SECRET.test(p.s) ||
    kind === undefined ||
    !Number.isSafeInteger(p.e)
  ) {
    return null;
  }
  return {
    origin: p.o,
    registryId: p.r,
    id: p.i,
    secret: p.s,
    kind,
    expiresAt: p.e as number,
  };
};

/** The `i.s` pair POST /v1/join takes. */
export const redemptionOf = (invite: Invite): string => `${invite.id}.${invite.secret}`;
