// @effect-diagnostics nodeBuiltinImport:off -- The .p8 key is parsed with node:crypto; Effect has no key parsing.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

// fork: this environment's own Apple push credentials, from three variables. Nothing here leaves
// the process: the key signs short-lived tokens for Apple's gateway and is never logged or sent.

export const APNS_KEY_FILE_ENV = "T3EXTEND_APNS_KEY_FILE";
export const APNS_KEY_ID_ENV = "T3EXTEND_APNS_KEY_ID";
export const APNS_TEAM_ID_ENV = "T3EXTEND_APNS_TEAM_ID";

export interface ApnsCredentials {
  readonly keyId: string;
  readonly teamId: string;
  readonly privateKey: NodeCrypto.KeyObject;
}

/** "absent": nothing was set, so push to iPhones is simply off. "invalid": something was set wrongly. */
export type ApnsConfig =
  | { readonly status: "configured"; readonly credentials: ApnsCredentials }
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly problem: string };

const APNS_NOT_CONFIGURED: ApnsConfig = { status: "absent" };

// Apple's key and team ids are ten letters and digits.
const APPLE_ID = /^[A-Za-z0-9]{10}$/;

/** A `.p8` file holds a PKCS#8 P-256 key; anything else cannot sign for APNs. */
function parseApnsPrivateKey(pem: string): NodeCrypto.KeyObject | null {
  try {
    const key = NodeCrypto.createPrivateKey(pem);
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      ? key
      : null;
  } catch {
    return null;
  }
}

/** Never throws, so a bad key cannot stop the server from starting. */
export const loadApnsConfig = Effect.fn("loadApnsConfig")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const keyFile = environment[APNS_KEY_FILE_ENV]?.trim() ?? "";
  const keyId = environment[APNS_KEY_ID_ENV]?.trim() ?? "";
  const teamId = environment[APNS_TEAM_ID_ENV]?.trim() ?? "";
  if (keyFile === "" && keyId === "" && teamId === "") return APNS_NOT_CONFIGURED;
  const missing = [
    [APNS_KEY_FILE_ENV, keyFile],
    [APNS_KEY_ID_ENV, keyId],
    [APNS_TEAM_ID_ENV, teamId],
  ].flatMap(([name, value]) => (value === "" ? [name] : []));
  if (missing.length > 0) {
    return { status: "invalid", problem: `${missing.join(", ")} not set` } as const;
  }
  if (!APPLE_ID.test(keyId) || !APPLE_ID.test(teamId)) {
    return {
      status: "invalid",
      problem: `${APNS_KEY_ID_ENV} and ${APNS_TEAM_ID_ENV} must be 10 letters or digits`,
    } as const;
  }
  const pem = yield* fs.readFileString(keyFile).pipe(Effect.option);
  if (pem._tag === "None") {
    return { status: "invalid", problem: `${APNS_KEY_FILE_ENV} could not be read` } as const;
  }
  const privateKey = parseApnsPrivateKey(pem.value);
  if (privateKey === null) {
    return {
      status: "invalid",
      problem: `${APNS_KEY_FILE_ENV} is not a P-256 private key (.p8)`,
    } as const;
  }
  return { status: "configured", credentials: { keyId, teamId, privateKey } } as const;
});
