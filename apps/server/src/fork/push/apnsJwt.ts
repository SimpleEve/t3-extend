// @effect-diagnostics nodeBuiltinImport:off -- Signing uses node:crypto; Effect has no ES256 primitive.
import * as NodeCrypto from "node:crypto";

import type { ApnsCredentials } from "./apnsConfig.ts";

// fork: Apple accepts a provider token for up to 60 minutes and throttles one that is renewed more
// often than every 20, so one token serves everything sent in between.
export const APNS_TOKEN_REUSE_SECONDS = 45 * 60;

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signApnsProviderToken(input: {
  readonly credentials: ApnsCredentials;
  readonly issuedAtSeconds: number;
}): string {
  const signingInput = `${encode({ alg: "ES256", kid: input.credentials.keyId })}.${encode({
    iss: input.credentials.teamId,
    iat: input.issuedAtSeconds,
  })}`;
  // JWS wants the raw r||s pair, not the DER that node produces by default.
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: input.credentials.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}
