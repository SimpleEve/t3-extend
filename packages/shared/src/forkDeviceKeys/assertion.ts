// fork: the one-shot pass a device signs for exactly one computer (design Q2 / 3.5).
import { ProofError, decodeJws, signJws, verifyJwsSignature, b64u, type DeviceJwk } from "./jws.ts";

const ASSERTION_TYP = "t3x-assertion+jwt";
export const ASSERTION_MAX_LIFETIME_SECONDS = 120;
export const ASSERTION_CLOCK_SKEW_SECONDS = 120;

export interface AssertionClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly rid: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly jkt: string;
}

/** `iss` and `sub` are the signing device's id, `jkt` the DPoP key the session will be bound to. */
export const signAssertion = (input: {
  readonly privateKey: Uint8Array;
  readonly deviceId: string;
  readonly audienceEnvironmentId: string;
  readonly registryId: string;
  readonly dpopThumbprint: string;
  readonly iat: number;
  readonly lifetimeSeconds?: number;
  readonly jti?: string;
}): { readonly assertion: string; readonly expiresAt: number } => {
  const exp = input.iat + (input.lifetimeSeconds ?? ASSERTION_MAX_LIFETIME_SECONDS);
  return {
    expiresAt: exp,
    assertion: signJws(
      { alg: "ES256", typ: ASSERTION_TYP, kid: input.deviceId },
      {
        v: 1,
        iss: input.deviceId,
        sub: input.deviceId,
        aud: input.audienceEnvironmentId,
        rid: input.registryId,
        iat: input.iat,
        exp,
        jti: input.jti ?? b64u.encode(globalThis.crypto.getRandomValues(new Uint8Array(16))),
        cnf: { jkt: input.dpopThumbprint },
      },
      input.privateKey,
    ),
  };
};

/** What the verifier can read before it knows the signer's key: the `kid` to look up. */
export const parseAssertion = (token: string) => {
  const decoded = decodeJws(token);
  const { header, payload } = decoded;
  if (header.alg !== "ES256" || header.typ !== ASSERTION_TYP || typeof header.kid !== "string") {
    throw new ProofError("bad_header");
  }
  const cnf = payload.cnf;
  const jkt =
    typeof cnf === "object" && cnf !== null ? (cnf as Record<string, unknown>).jkt : undefined;
  if (
    payload.v !== 1 ||
    typeof payload.iss !== "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.aud !== "string" ||
    typeof payload.rid !== "string" ||
    typeof payload.jti !== "string" ||
    typeof jkt !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp)
  ) {
    throw new ProofError("bad_payload");
  }
  const claims: AssertionClaims = {
    iss: payload.iss,
    sub: payload.sub,
    aud: payload.aud,
    rid: payload.rid,
    iat: payload.iat,
    exp: payload.exp,
    jti: payload.jti,
    jkt,
  };
  return { kid: header.kid, claims, decoded };
};

export const verifyAssertionSignature = (
  parsed: ReturnType<typeof parseAssertion>,
  jwk: DeviceJwk,
): boolean => verifyJwsSignature(parsed.decoded, jwk);
