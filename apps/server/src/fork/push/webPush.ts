// @effect-diagnostics nodeBuiltinImport:off -- RFC 8291 needs ECDH and HKDF, which Effect's Crypto does not offer.
import * as NodeCrypto from "node:crypto";

// fork: Web Push message encryption (RFC 8291, aes128gcm content coding from RFC 8188).
// VAPID (RFC 8292) is deliberately absent: a UnifiedPush endpoint is itself the capability,
// and ntfy accepts writes to its up* topics without authenticating the sender.

const P256_PUBLIC_KEY_BYTES = 65;
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
const RECORD_SIZE = 4096;
const AES_GCM_TAG_BYTES = 16;
// Push services only promise to accept 4096 bytes of body (RFC 8030): the 86-byte
// header, the 0x02 last-record delimiter and the GCM tag come out of that.
const HEADER_BYTES = SALT_BYTES + 4 + 1 + P256_PUBLIC_KEY_BYTES;
export const MAX_PLAINTEXT_BYTES = 4096 - HEADER_BYTES - 1 - AES_GCM_TAG_BYTES;

export interface WebPushKeys {
  /** The phone's uncompressed P-256 public key. */
  readonly p256dh: Buffer;
  readonly auth: Buffer;
}

/** Accepts base64url with or without padding, as distributors differ. */
export function decodeWebPushKeys(p256dh: string, auth: string): WebPushKeys | null {
  const publicKey = Buffer.from(p256dh.replace(/=+$/, ""), "base64url");
  const authSecret = Buffer.from(auth.replace(/=+$/, ""), "base64url");
  if (publicKey.length !== P256_PUBLIC_KEY_BYTES || publicKey[0] !== 0x04) return null;
  if (authSecret.length !== AUTH_SECRET_BYTES) return null;
  try {
    // Rejects points that are not on the curve before any secret is derived from them.
    const probe = NodeCrypto.createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(publicKey);
  } catch {
    return null;
  }
  return { p256dh: publicKey, auth: authSecret };
}

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer =>
  Buffer.from(NodeCrypto.hkdfSync("sha256", ikm, salt, info, length));

/** RFC 8291 section 3.4 and RFC 8188 section 2.2. */
function deriveRecordKeys(input: {
  readonly ecdhSecret: Uint8Array;
  readonly auth: Uint8Array;
  readonly receiverPublic: Uint8Array;
  readonly senderPublic: Uint8Array;
  readonly salt: Uint8Array;
}) {
  const prkKey = NodeCrypto.createHmac("sha256", input.auth).update(input.ecdhSecret).digest();
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    input.receiverPublic,
    input.senderPublic,
    Buffer.from([0x01]),
  ]);
  // HKDF-Expand to one block is a single HMAC; hkdfSync would extract again.
  const ikm = NodeCrypto.createHmac("sha256", prkKey).update(keyInfo).digest();
  return {
    contentKey: hkdf(ikm, input.salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
    nonce: hkdf(ikm, input.salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  };
}

export interface EncryptWebPushInput {
  readonly plaintext: Uint8Array;
  readonly keys: WebPushKeys;
  /** Fixed only by tests that replay a published vector. */
  readonly salt?: Uint8Array;
  readonly senderPrivateKey?: Uint8Array;
}

/**
 * The HTTP body for one Web Push message: the RFC 8188 header (salt, record
 * size, sender public key) followed by a single encrypted record.
 */
export function encryptWebPush(input: EncryptWebPushInput): Buffer {
  if (input.plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`Push payload exceeds ${MAX_PLAINTEXT_BYTES} bytes.`);
  }
  const sender = NodeCrypto.createECDH("prime256v1");
  if (input.senderPrivateKey === undefined) sender.generateKeys();
  else sender.setPrivateKey(input.senderPrivateKey);
  const senderPublic = sender.getPublicKey();
  const salt = input.salt ?? NodeCrypto.randomBytes(SALT_BYTES);

  const { contentKey, nonce } = deriveRecordKeys({
    ecdhSecret: sender.computeSecret(input.keys.p256dh),
    auth: input.keys.auth,
    receiverPublic: input.keys.p256dh,
    senderPublic,
    salt,
  });

  const cipher = NodeCrypto.createCipheriv("aes-128-gcm", contentKey, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(input.plaintext), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(SALT_BYTES + 4 + 1);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(senderPublic.length, SALT_BYTES + 4);
  return Buffer.concat([header, senderPublic, record]);
}

/** The inverse of {@link encryptWebPush}; the phone's connector library does this on-device. */
export function decryptWebPush(body: Uint8Array, privateKey: Uint8Array, auth: Uint8Array): Buffer {
  const message = Buffer.from(body);
  const salt = message.subarray(0, SALT_BYTES);
  const idLength = message.readUInt8(SALT_BYTES + 4);
  const senderPublic = message.subarray(SALT_BYTES + 5, SALT_BYTES + 5 + idLength);
  const record = message.subarray(SALT_BYTES + 5 + idLength);

  const receiver = NodeCrypto.createECDH("prime256v1");
  receiver.setPrivateKey(privateKey);
  const receiverPublic = receiver.getPublicKey();
  const { contentKey, nonce } = deriveRecordKeys({
    ecdhSecret: receiver.computeSecret(senderPublic),
    auth,
    receiverPublic,
    senderPublic,
    salt,
  });

  const decipher = NodeCrypto.createDecipheriv("aes-128-gcm", contentKey, nonce);
  decipher.setAuthTag(record.subarray(record.length - AES_GCM_TAG_BYTES));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - AES_GCM_TAG_BYTES)),
    decipher.final(),
  ]);
  // Padding is zeros after the 0x02 delimiter, so the last non-zero byte must be it.
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  if (end === 0 || padded[end - 1] !== 0x02) throw new Error("Push record has no delimiter.");
  return padded.subarray(0, end - 1);
}
