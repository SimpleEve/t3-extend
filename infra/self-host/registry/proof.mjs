// JWS (ES256), device-key fingerprints, the canonical public origin and the T3X-Proof request signature.
// Zero dependencies: only node:crypto and node:url. Spec: research/self-host-device-keys.md 3.1, 3.4, 3.12 B.
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

const {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign: cryptoSign,
  verify: cryptoVerify,
} = NodeCrypto;
const { domainToASCII } = NodeURL;

export const PROOF_TYP = "t3x-req+jwt";
export const TICKET_TYP = "t3x-ticket+jwt";
export const PROOF_WINDOW_SECONDS = 120;
/** A `jti` is remembered until `iat + SEEN_JTI_SECONDS`. */
export const SEEN_JTI_SECONDS = 240;

export class ProofError extends Error {
  /** @param {string} reason log-only; callers never show it to the requester */
  constructor(reason) {
    super(reason);
    this.name = "ProofError";
    this.reason = reason;
  }
}

const B64U = /^[A-Za-z0-9_-]*$/;

export const b64u = {
  /** @param {Uint8Array | string} data */
  encode(data) {
    return Buffer.from(data).toString("base64url");
  },
  /** Strict: no padding, no other alphabet, and the canonical encoding only. Returns null when invalid. */
  decode(text) {
    if (typeof text !== "string" || !B64U.test(text) || text.length % 4 === 1) return null;
    const bytes = Buffer.from(text, "base64url");
    return bytes.toString("base64url") === text ? bytes : null;
  },
};

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const keyCache = new Map();
const KEY_CACHE_LIMIT = 512;

/** Returns the canonical `{kty,crv,x,y}` or null when the input is not exactly a P-256 public JWK on the curve. */
export function normalizeJwk(jwk) {
  if (!isPlainObject(jwk)) return null;
  if (Object.keys(jwk).sort().join(",") !== "crv,kty,x,y") return null;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") return null;
  for (const coordinate of [jwk.x, jwk.y]) {
    if (b64u.decode(coordinate)?.length !== 32) return null;
  }
  const canonical = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  try {
    createPublicKey({ key: canonical, format: "jwk" });
  } catch {
    return null;
  }
  return canonical;
}

/** RFC 7638 thumbprint; this is the device id. `jwk` must already be normalized. */
export function jwkThumbprint(jwk) {
  const members = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64u.encode(createHash("sha256").update(members).digest());
}

export function publicKeyFromJwk(jwk) {
  const id = jwkThumbprint(jwk);
  let key = keyCache.get(id);
  if (key === undefined) {
    key = createPublicKey({ key: jwk, format: "jwk" });
    if (keyCache.size >= KEY_CACHE_LIMIT) keyCache.delete(keyCache.keys().next().value);
    keyCache.set(id, key);
  }
  return key;
}

/** For devices (and tests): a fresh P-256 key with its public JWK and device id. */
export function generateDeviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = normalizeJwk(publicKey.export({ format: "jwk" }));
  return { privateKey, jwk, id: jwkThumbprint(jwk) };
}

export function signJws(header, payload, privateKey) {
  const signingInput = `${b64u.encode(JSON.stringify(header))}.${b64u.encode(JSON.stringify(payload))}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64u.encode(signature)}`;
}

/** Splits and decodes a compact JWS without trusting any of it. Throws ProofError("malformed"). */
export function decodeJws(token, { maxLength = 4096 } = {}) {
  if (typeof token !== "string" || token.length === 0 || token.length > maxLength) {
    throw new ProofError("malformed");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new ProofError("malformed");
  const [headerText, payloadText, signatureText] = parts;
  const headerBytes = b64u.decode(headerText);
  const payloadBytes = b64u.decode(payloadText);
  const signature = b64u.decode(signatureText);
  if (headerBytes === null || payloadBytes === null || signature?.length !== 64) {
    throw new ProofError("malformed");
  }
  let header;
  let payload;
  try {
    header = JSON.parse(headerBytes.toString("utf8"));
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new ProofError("malformed");
  }
  if (!isPlainObject(header) || !isPlainObject(payload)) throw new ProofError("malformed");
  return { header, payload, signature, signingInput: `${headerText}.${payloadText}` };
}

export function verifyJwsSignature(decoded, publicKey) {
  try {
    return cryptoVerify(
      "sha256",
      Buffer.from(decoded.signingInput),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      decoded.signature,
    );
  } catch {
    return false;
  }
}

/** `https://host[:port]`, lowercase, punycode host, default port omitted. Throws on anything else. */
export function canonicalOrigin(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error(`not a URL: ${input}`);
  }
  if (url.protocol !== "https:") throw new Error("the public origin must be https");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(
      "the public origin must be a bare origin: no userinfo, path, query or fragment",
    );
  }
  const isIpv6 = url.hostname.startsWith("[");
  const host = isIpv6 ? url.hostname : domainToASCII(url.hostname);
  if (host === "" || host.endsWith(".")) throw new Error("the public origin has no usable host");
  return `https://${host}${url.port === "" ? "" : `:${url.port}`}`;
}

export function originParts(origin) {
  const url = new URL(origin);
  return { host: url.hostname, port: url.port === "" ? 443 : Number(url.port) };
}

const JTI = /^[A-Za-z0-9_-]{22}$/;

export function bodyHash(body) {
  return b64u.encode(createHash("sha256").update(body).digest());
}

/**
 * Signer side. `kid` for registered devices; the public `jwk` instead for POST /join (proof of possession).
 * `htu` is the canonical origin + path exactly as sent on the request line.
 */
export function signRequestProof({
  privateKey,
  kid,
  jwk,
  method,
  htu,
  body = Buffer.alloc(0),
  iat = Math.floor(Date.now() / 1000),
  jti = b64u.encode(randomBytes(16)),
}) {
  const header = { alg: "ES256", typ: PROOF_TYP, ...(kid === undefined ? { jwk } : { kid }) };
  const payload = {
    htm: method,
    htu,
    iat,
    jti,
    ...(body.length > 0 ? { bh: bodyHash(body) } : {}),
  };
  return signJws(header, payload, privateKey);
}

/** Verifier step 1: shape only. The caller then looks up `header.kid` (or uses `header.jwk`). */
export function parseRequestProof(token) {
  const decoded = decodeJws(token);
  const { header, payload } = decoded;
  if (header.alg !== "ES256" || header.typ !== PROOF_TYP) throw new ProofError("bad_header");
  const hasKid = typeof header.kid === "string";
  const hasJwk = header.jwk !== undefined;
  if (hasKid === hasJwk) throw new ProofError("bad_header");
  if (
    typeof payload.htm !== "string" ||
    typeof payload.htu !== "string" ||
    !Number.isSafeInteger(payload.iat) ||
    typeof payload.jti !== "string" ||
    (payload.bh !== undefined && typeof payload.bh !== "string")
  ) {
    throw new ProofError("bad_payload");
  }
  return decoded;
}

/**
 * Verifier step 2, in the order the spec gives: signature, method and URL, time window, body hash.
 * Returns what the caller needs to record the `jti` (the replay insert is the caller's last step).
 */
export function verifyRequestProof(decoded, { publicKey, method, htu, now, body }) {
  if (!verifyJwsSignature(decoded, publicKey)) throw new ProofError("bad_signature");
  const { payload } = decoded;
  if (payload.htm !== method) throw new ProofError("method_mismatch");
  if (payload.htu !== htu) throw new ProofError("htu_mismatch");
  if (Math.abs(now - payload.iat) > PROOF_WINDOW_SECONDS) throw new ProofError("time_window");
  if (!JTI.test(payload.jti)) throw new ProofError("bad_jti");
  if (body.length > 0) {
    if (payload.bh !== bodyHash(body)) throw new ProofError("bh_mismatch");
  } else if (payload.bh !== undefined) {
    throw new ProofError("unexpected_bh");
  }
  return { jti: payload.jti, expiresAt: payload.iat + SEEN_JTI_SECONDS };
}

export function signTicket({ privateKey, kid, rid, sub, gen, iat, exp = iat + 86400 }) {
  return signJws(
    { alg: "ES256", typ: TICKET_TYP, kid },
    { v: 1, iss: kid, rid, sub, gen, iat, exp },
    privateKey,
  );
}
