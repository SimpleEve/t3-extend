import type { RegistryDevice } from "@t3tools/contracts";
import { translatorFor } from "@t3tools/client-runtime/i18n";
import { describe, expect, it } from "vite-plus/test";

import { describeDevice, serverNotice } from "./serverDevicesPresentation";
import type { DeviceSyncState } from "./deviceSync";

const t = translatorFor("en");
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const seconds = (ms: number) => Math.floor(ms / 1000);

const joined = (overrides: Partial<Extract<DeviceSyncState, { _tag: "joined" }>>) =>
  ({
    _tag: "joined",
    membership: {
      v: 1,
      origin: "https://t3.example.com",
      registryId: "abcdefgh",
      deviceId: "me",
      name: "Pixel",
      joinedAt: 1,
    },
    devices: [],
    rev: 1,
    fetchedAt: seconds(NOW) - 600,
    unreachable: false,
    ...overrides,
  }) satisfies DeviceSyncState;

const device = (overrides: Partial<RegistryDevice>): RegistryDevice => ({
  id: "d",
  name: "Device",
  kind: "computer",
  jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  createdAt: 1,
  lastSeenAt: seconds(NOW) - 2 * 3600,
  ...overrides,
});

describe("what the phone says about the link to the server", () => {
  it("is quiet while the last refresh worked, however old it is", () => {
    expect(serverNotice(t, joined({}), NOW)).toBeNull();
  });

  it("says how long ago it last synced once a refresh failed", () => {
    expect(serverNotice(t, joined({ unreachable: true }), NOW)).toBe(
      "Can't reach your server right now. Last synced 10 minutes ago.",
    );
    expect(serverNotice(t, joined({ unreachable: true, fetchedAt: null }), NOW)).toBe(
      "Can't reach your server right now.",
    );
  });
});

describe("a device's second line", () => {
  const options = { waiting: false, nowMs: NOW };

  it.each([
    [device({ online: true }), options, "Computer · online"],
    [device({}), options, "Computer · seen 2h"],
    [device({ kind: "phone" }), options, "Phone · seen 2h"],
    // Waiting for the other computer is not a failure and is not shown as one.
    [
      device({ online: true }),
      { ...options, waiting: true },
      "Waiting for that computer to confirm…",
    ],
  ])("reads %# correctly", (entry, opts, expected) => {
    expect(describeDevice(t, entry, opts)).toBe(expected);
  });
});
