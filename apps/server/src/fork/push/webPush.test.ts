// @effect-diagnostics nodeBuiltinImport:off -- The test vector replays raw ECDH and HKDF.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { RFC8291_VECTOR as V } from "./rfc8291Vector.ts";
import {
  decodeWebPushKeys,
  decryptWebPush,
  encryptWebPush,
  MAX_PLAINTEXT_BYTES,
} from "./webPush.ts";

const b64 = (value: string) => Buffer.from(value, "base64url");

describe("Web Push encryption (RFC 8291)", () => {
  it("reproduces the Appendix A message byte for byte", () => {
    const keys = decodeWebPushKeys(V.uaPublic, V.authSecret);
    expect(keys).not.toBeNull();
    const body = encryptWebPush({
      plaintext: b64(V.plaintextB64),
      keys: keys!,
      salt: b64(V.salt),
      senderPrivateKey: b64(V.asPrivate),
    });
    expect(body).toEqual(Buffer.concat([b64(V.header), b64(V.ciphertext)]));
  });

  it("decrypts the Appendix A message with the user agent key", () => {
    const body = Buffer.concat([b64(V.header), b64(V.ciphertext)]);
    expect(decryptWebPush(body, b64(V.uaPrivate), b64(V.authSecret)).toString()).toBe(
      "When I grow up, I want to be a watermelon",
    );
  });

  it("round-trips with a fresh sender key and salt", () => {
    const receiver = NodeCrypto.createECDH("prime256v1");
    receiver.generateKeys();
    const auth = NodeCrypto.randomBytes(16);
    const keys = decodeWebPushKeys(
      receiver.getPublicKey().toString("base64url"),
      auth.toString("base64url"),
    )!;
    const plaintext = Buffer.from(JSON.stringify({ title: "完成 ✓" }));
    const first = encryptWebPush({ plaintext, keys });
    const second = encryptWebPush({ plaintext, keys });
    expect(first.equals(second)).toBe(false);
    expect(decryptWebPush(first, receiver.getPrivateKey(), auth)).toEqual(plaintext);
  });

  it("refuses payloads that would not fit a single push message", () => {
    const keys = decodeWebPushKeys(V.uaPublic, V.authSecret)!;
    expect(() =>
      encryptWebPush({ plaintext: Buffer.alloc(MAX_PLAINTEXT_BYTES), keys }),
    ).not.toThrow();
    expect(() =>
      encryptWebPush({ plaintext: Buffer.alloc(MAX_PLAINTEXT_BYTES + 1), keys }),
    ).toThrow(RangeError);
  });

  it("rejects malformed subscription keys", () => {
    expect(decodeWebPushKeys(V.uaPublic, "AAAA")).toBeNull();
    expect(decodeWebPushKeys("AAAA", V.authSecret)).toBeNull();
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString(
      "base64url",
    );
    expect(decodeWebPushKeys(offCurve, V.authSecret)).toBeNull();
    expect(decodeWebPushKeys(`${V.uaPublic}=`, `${V.authSecret}==`)).not.toBeNull();
  });
});
