// fork: compact ES256 JWS, device-key fingerprints and strict base64url, shared by the server,
// client-runtime and the phone. Byte-for-byte compatible with infra/self-host/registry/proof.mjs.
import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// @effect-diagnostics-next-line extendsNativeError:off - fork: a plain throw shared by sync verifiers on the server, the phone and the registry client; no Effect runtime here.
export class ProofError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "ProofError";
    this.reason = reason;
  }
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const B64U = /^[A-Za-z0-9_-]*$/;

export const b64u = {
  encode: (data: Uint8Array | string): string =>
    Base64Url.encode(typeof data === "string" ? textEncoder.encode(data) : data),
  /** Strict: no padding, no other alphabet, canonical encoding only. Null when invalid. */
  decode: (text: unknown): Uint8Array | null => {
    if (typeof text !== "string" || !B64U.test(text) || text.length % 4 === 1) return null;
    const decoded = Base64Url.decode(text);
    if (Result.isFailure(decoded)) return null;
    return Base64Url.encode(decoded.success) === text ? decoded.success : null;
  },
};

export const sha256B64u = (data: Uint8Array | string) =>
  b64u.encode(sha256(typeof data === "string" ? textEncoder.encode(data) : data));

/** `{kty,crv,x,y}`, nothing else. */
export interface DeviceJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const publicKeyBytes = (jwk: DeviceJwk) => {
  const key = new Uint8Array(65);
  key[0] = 4;
  key.set(b64u.decode(jwk.x) ?? [], 1);
  key.set(b64u.decode(jwk.y) ?? [], 33);
  return key;
};

/** The canonical JWK, or null unless the input is exactly a P-256 public key on the curve. */
export const normalizeJwk = (jwk: unknown): DeviceJwk | null => {
  if (!isPlainObject(jwk)) return null;
  if (Object.keys(jwk).sort().join(",") !== "crv,kty,x,y") return null;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") return null;
  if (b64u.decode(jwk.x)?.length !== 32 || b64u.decode(jwk.y)?.length !== 32) return null;
  const canonical = { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string } as const;
  try {
    p256.ProjectivePoint.fromHex(publicKeyBytes(canonical)).assertValidity();
  } catch {
    return null;
  }
  return canonical;
};

/** RFC 7638 thumbprint; this is the device id. */
export const deviceIdOf = (jwk: DeviceJwk): string =>
  sha256B64u(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`);

export interface DeviceKeyPair {
  readonly privateKey: Uint8Array;
  readonly jwk: DeviceJwk;
  readonly id: string;
}

export const deviceKeyFromPrivate = (privateKey: Uint8Array): DeviceKeyPair => {
  const point = p256.getPublicKey(privateKey, false);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64u.encode(point.slice(1, 33)),
    y: b64u.encode(point.slice(33, 65)),
  } as const;
  return { privateKey, jwk, id: deviceIdOf(jwk) };
};

export const generateDeviceKey = (): DeviceKeyPair =>
  deviceKeyFromPrivate(p256.utils.randomPrivateKey());

export const signJws = (
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: Uint8Array,
): string => {
  const signingInput = `${b64u.encode(encodeJson(header))}.${b64u.encode(encodeJson(payload))}`;
  const signature = p256
    .sign(sha256(textEncoder.encode(signingInput)), privateKey, { prehash: false })
    .toCompactRawBytes();
  return `${signingInput}.${b64u.encode(signature)}`;
};

export interface DecodedJws {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signature: Uint8Array;
  readonly signingInput: string;
}

/** Splits and decodes a compact JWS without trusting any of it. Throws ProofError("malformed"). */
export const decodeJws = (token: unknown, maxLength = 4096): DecodedJws => {
  if (typeof token !== "string" || token.length === 0 || token.length > maxLength) {
    throw new ProofError("malformed");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new ProofError("malformed");
  const [headerText, payloadText, signatureText] = parts as [string, string, string];
  const headerBytes = b64u.decode(headerText);
  const payloadBytes = b64u.decode(payloadText);
  const signature = b64u.decode(signatureText);
  if (headerBytes === null || payloadBytes === null || signature?.length !== 64) {
    throw new ProofError("malformed");
  }
  let header: unknown;
  let payload: unknown;
  try {
    header = decodeJson(textDecoder.decode(headerBytes));
    payload = decodeJson(textDecoder.decode(payloadBytes));
  } catch {
    throw new ProofError("malformed");
  }
  if (!isPlainObject(header) || !isPlainObject(payload)) throw new ProofError("malformed");
  return { header, payload, signature, signingInput: `${headerText}.${payloadText}` };
};

export const verifyJwsSignature = (decoded: DecodedJws, jwk: DeviceJwk): boolean => {
  try {
    return p256.verify(
      decoded.signature,
      sha256(textEncoder.encode(decoded.signingInput)),
      publicKeyBytes(jwk),
      { prehash: false, format: "compact" },
    );
  } catch {
    return false;
  }
};
