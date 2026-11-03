// fork: the T3X-Proof request signature the registry checks (design 3.4 / 3.12 B), the canonical
// registry origin, and the tunnel ticket. Mirrors registry/proof.mjs.
import {
  ProofError,
  b64u,
  decodeJws,
  sha256B64u,
  signJws,
  verifyJwsSignature,
  type DecodedJws,
  type DeviceJwk,
} from "./jws.ts";

const PROOF_TYP = "t3x-req+jwt";
const TICKET_TYP = "t3x-ticket+jwt";
const PROOF_WINDOW_SECONDS = 120;

/** `https://host[:port]`, lowercase, punycode host, default port omitted. Throws on anything else. */
export const canonicalOrigin = (input: string): string => {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("the registry origin must be https");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("the registry origin must be a bare origin");
  }
  if (url.hostname === "" || url.hostname.endsWith(".")) throw new Error("no usable host");
  return `https://${url.hostname}${url.port === "" ? "" : `:${url.port}`}`;
};

const bodyHash = (body: Uint8Array): string => sha256B64u(body);

const randomJti = () => b64u.encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/**
 * Signs one registry request. Registered devices send `kid`; POST /join sends the public `jwk`
 * instead. `htu` is the canonical origin + the path exactly as sent on the request line.
 */
export const signRequestProof = (input: {
  readonly privateKey: Uint8Array;
  readonly kid?: string;
  readonly jwk?: DeviceJwk;
  readonly method: string;
  readonly htu: string;
  readonly body?: Uint8Array;
  readonly iat: number;
  readonly jti?: string;
}): string => {
  const body = input.body ?? new Uint8Array();
  return signJws(
    {
      alg: "ES256",
      typ: PROOF_TYP,
      ...(input.kid === undefined ? { jwk: input.jwk } : { kid: input.kid }),
    },
    {
      htm: input.method,
      htu: input.htu,
      iat: input.iat,
      jti: input.jti ?? randomJti(),
      ...(body.length > 0 ? { bh: bodyHash(body) } : {}),
    },
    input.privateKey,
  );
};

/** Verifier side; used by the cross-checks and by tests that act as a registry. */
export const verifyRequestProof = (
  token: string,
  expected: {
    readonly jwk: DeviceJwk;
    readonly method: string;
    readonly htu: string;
    readonly now: number;
    readonly body: Uint8Array;
  },
): { readonly jti: string } => {
  const decoded = decodeJws(token);
  const { header, payload } = decoded;
  if (header.alg !== "ES256" || header.typ !== PROOF_TYP) throw new ProofError("bad_header");
  if (!verifyJwsSignature(decoded, expected.jwk)) throw new ProofError("bad_signature");
  if (payload.htm !== expected.method) throw new ProofError("method_mismatch");
  if (payload.htu !== expected.htu) throw new ProofError("htu_mismatch");
  if (
    typeof payload.iat !== "number" ||
    Math.abs(expected.now - payload.iat) > PROOF_WINDOW_SECONDS
  ) {
    throw new ProofError("time_window");
  }
  if (typeof payload.jti !== "string") throw new ProofError("bad_jti");
  if (
    expected.body.length > 0 ? payload.bh !== bodyHash(expected.body) : payload.bh !== undefined
  ) {
    throw new ProofError("bh_mismatch");
  }
  return { jti: payload.jti };
};

/** The computer's frpc login ticket (8.3 consumes it; here so both sides share one signer). */
export const signTicket = (input: {
  readonly privateKey: Uint8Array;
  readonly kid: string;
  readonly rid: string;
  readonly sub: string;
  readonly gen: number;
  readonly iat: number;
  readonly exp?: number;
}): string =>
  signJws(
    { alg: "ES256", typ: TICKET_TYP, kid: input.kid },
    {
      v: 1,
      iss: input.kid,
      rid: input.rid,
      sub: input.sub,
      gen: input.gen,
      iat: input.iat,
      exp: input.exp ?? input.iat + 86_400,
    },
    input.privateKey,
  );

export type { DecodedJws };
