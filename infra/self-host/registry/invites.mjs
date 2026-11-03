// Invite strings: "t3x1." + base64url(JSON). Spec: research/self-host-device-keys.md 3.2 and Q9.
import { b64u } from "./proof.mjs";

export const INVITE_PREFIX = "t3x1.";
const INVITE_ID = /^[A-Za-z0-9_-]{11}$/;
const INVITE_SECRET = /^[A-Za-z0-9_-]{22}$/;
const REGISTRY_ID = /^[a-z2-7]{8}$/;

const KIND_TO_CODE = { computer: "c", phone: "p", any: "a" };
const CODE_TO_KIND = { c: "computer", p: "phone", a: "any" };

/** The invite string the operator hands to a device. `expiresAt` only lets clients reject early. */
export function encodeInvite({ origin, registryId, id, secret, kind, expiresAt }) {
  const payload = {
    v: 1,
    o: origin,
    r: registryId,
    i: id,
    s: secret,
    k: KIND_TO_CODE[kind],
    e: expiresAt,
  };
  return `${INVITE_PREFIX}${b64u.encode(JSON.stringify(payload))}`;
}

/** Strict parse; returns null for anything that is not a version-1 invite. */
export function decodeInvite(text) {
  if (typeof text !== "string" || !text.startsWith(INVITE_PREFIX)) return null;
  const bytes = b64u.decode(text.slice(INVITE_PREFIX.length));
  if (bytes === null) return null;
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || payload.v !== 1) return null;
  const kind = CODE_TO_KIND[payload.k];
  if (
    typeof payload.o !== "string" ||
    payload.o.length > 80 ||
    !REGISTRY_ID.test(payload.r) ||
    !INVITE_ID.test(payload.i) ||
    !INVITE_SECRET.test(payload.s) ||
    kind === undefined ||
    !Number.isSafeInteger(payload.e)
  ) {
    return null;
  }
  return {
    origin: payload.o,
    registryId: payload.r,
    id: payload.i,
    secret: payload.s,
    kind,
    expiresAt: payload.e,
  };
}

/** The `i.s` pair a device sends to POST /v1/join. Null when it is not shaped like one. */
export function parseRedemption(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(".");
  if (parts.length !== 2 || !INVITE_ID.test(parts[0]) || !INVITE_SECRET.test(parts[1])) return null;
  return { id: parts[0], secret: parts[1] };
}
