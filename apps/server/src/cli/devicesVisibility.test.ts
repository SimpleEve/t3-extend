import { assert, describe, it } from "@effect/vitest";

import { resolveDevices } from "./devicesVisibility.ts";

const input = {
  devices: [
    { id: "a".repeat(43), name: "Laptop" },
    { id: "b".repeat(43), name: "Pixel" },
    { id: "c".repeat(43), name: "Studio" },
  ],
  hiddenPeers: [{ id: "d".repeat(43) }],
  selfId: "c".repeat(43),
};

describe("resolveDevices", () => {
  it("finds devices by name, case-insensitively, or by the start of an id", () => {
    assert.deepEqual(resolveDevices(["laptop", "b".repeat(10)], input), [
      "a".repeat(43),
      "b".repeat(43),
    ]);
  });

  it("finds a computer hidden from this one by its id alone", () => {
    assert.deepEqual(resolveDevices(["d".repeat(8)], input), ["d".repeat(43)]);
  });

  it("explains what it could not use, instead of picking something", () => {
    assert.match(String(resolveDevices(["Nobody"], input)), /No device named Nobody/);
    assert.match(String(resolveDevices(["aaaa"], input)), /No device named aaaa/);
    assert.match(
      String(
        resolveDevices(["aaaaaaaa"], {
          ...input,
          devices: [...input.devices, { id: "a".repeat(8) + "e".repeat(35), name: "Other" }],
        }),
      ),
      /More than one device matches/,
    );
    assert.match(String(resolveDevices(["Studio"], input)), /cannot be in its own list/);
  });

  it("says a device that joined after the last sync needs its id, and does not sync from here", () => {
    const message = String(resolveDevices(["Newcomer"], input));
    assert.match(message, /No device named Newcomer in the list from the last sync/);
    assert.match(message, /start of its id/);
    assert.match(message, /running T3/);
  });
});
