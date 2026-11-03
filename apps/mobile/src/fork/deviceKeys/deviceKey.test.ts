import { describe, expect, it } from "vite-plus/test";

import { DEVICE_KEY_ITEM, createDeviceKey, readDeviceKey, type SecretStore } from "./deviceKey";

const memoryStore = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  const store: SecretStore = {
    getItemAsync: async (key) => items.get(key) ?? null,
    setItemAsync: async (key, value) => void items.set(key, value),
    deleteItemAsync: async (key) => void items.delete(key),
  };
  return { store, items };
};

const bytes = (fill: number) => new Uint8Array(32).fill(fill);

describe("the phone's device key", () => {
  it("is created once and read back as the same key", async () => {
    const { store, items } = memoryStore();
    expect(await readDeviceKey(store)).toEqual({ _tag: "missing" });
    const created = await createDeviceKey(store, () => bytes(7));
    const read = await readDeviceKey(store);
    expect(read._tag).toBe("ready");
    if (read._tag === "ready") expect(read.key.id).toBe(created.id);
    expect(items.size).toBe(1);
  });

  it("draws again when the generator hands back a number that is not a valid key", async () => {
    const { store } = memoryStore();
    const draws = [new Uint8Array(32), bytes(9)];
    const created = await createDeviceKey(store, () => draws.shift()!);
    expect((await readDeviceKey(store))._tag).toBe("ready");
    expect(created.id).not.toBe("");
  });

  it("reports damage for every way the stored value can be wrong, and deletes nothing", async () => {
    const good = JSON.parse(
      (await (async () => {
        const { store, items } = memoryStore();
        await createDeviceKey(store, () => bytes(3));
        return items.get(DEVICE_KEY_ITEM)!;
      })()) as string,
    ) as { v: number; d: string; id: string };
    for (const stored of [
      "not json",
      "null",
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, d: good.d.slice(0, 20) }),
      JSON.stringify({ ...good, d: "!!" }),
      // The fingerprint no longer matches the key.
      JSON.stringify({ ...good, id: "x".repeat(43) }),
    ]) {
      const { store, items } = memoryStore({ [DEVICE_KEY_ITEM]: stored });
      expect(await readDeviceKey(store)).toEqual({ _tag: "damaged" });
      expect(items.get(DEVICE_KEY_ITEM)).toBe(stored);
    }
  });

  it("does not call a keychain that will not answer a damaged key", async () => {
    const store: SecretStore = {
      getItemAsync: async () => {
        throw new Error("keychain locked");
      },
      setItemAsync: async () => {},
      deleteItemAsync: async () => {},
    };
    await expect(readDeviceKey(store)).rejects.toThrow("keychain locked");
  });
});
