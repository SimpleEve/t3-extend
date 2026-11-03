// fork: the phone's device key (design Q3). It sits in the system keychain, encrypted at rest; the
// registry knows only its public half. Reading never deletes anything: a keychain that cannot be
// read right now is not a damaged key.
import { p256 } from "@noble/curves/nist";
import { b64u, deviceKeyFromPrivate, type DeviceKeyPair } from "@t3tools/shared/forkDeviceKeys/jws";

export interface SecretStore {
  readonly getItemAsync: (key: string) => Promise<string | null>;
  readonly setItemAsync: (key: string, value: string) => Promise<void>;
  readonly deleteItemAsync: (key: string) => Promise<void>;
}

export const DEVICE_KEY_ITEM = "t3x.deviceKey.v1";

export type StoredDeviceKey =
  | { readonly _tag: "missing" }
  | { readonly _tag: "damaged" }
  | { readonly _tag: "ready"; readonly key: DeviceKeyPair };

export async function readDeviceKey(store: SecretStore): Promise<StoredDeviceKey> {
  const text = await store.getItemAsync(DEVICE_KEY_ITEM);
  if (text === null) return { _tag: "missing" };
  try {
    const stored: unknown = JSON.parse(text);
    if (typeof stored !== "object" || stored === null) return { _tag: "damaged" };
    const { v, d, id } = stored as Record<string, unknown>;
    const privateKey = v === 1 ? b64u.decode(d) : null;
    if (privateKey === null || privateKey.length !== 32) return { _tag: "damaged" };
    const key = deviceKeyFromPrivate(privateKey);
    // The id is the key's fingerprint: a stored value that no longer matches was altered or cut.
    return key.id === id ? { _tag: "ready", key } : { _tag: "damaged" };
  } catch {
    return { _tag: "damaged" };
  }
}

export async function createDeviceKey(
  store: SecretStore,
  randomBytes: (count: number) => Uint8Array,
): Promise<DeviceKeyPair> {
  let privateKey = randomBytes(32);
  // An out-of-range draw is a one-in-2^32 chance from a sound generator; draw again.
  while (!p256.utils.isValidPrivateKey(privateKey)) privateKey = randomBytes(32);
  const key = deviceKeyFromPrivate(privateKey);
  await store.setItemAsync(
    DEVICE_KEY_ITEM,
    JSON.stringify({ v: 1, d: b64u.encode(key.privateKey), id: key.id }),
  );
  return key;
}

export const deleteDeviceKey = (store: SecretStore) => store.deleteItemAsync(DEVICE_KEY_ITEM);
