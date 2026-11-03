import { describe, expect, it } from "vite-plus/test";
import { encodeInvite } from "@t3tools/shared/forkDeviceKeys/invite";

import type { DevicesSnapshot } from "@t3tools/contracts";

import { inviteDeadlineLabel, readInvite, serverNotice, snapshotToView } from "./deviceKeysLogic";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const seconds = (ms: number) => Math.floor(ms / 1000);

describe("what the Devices section says about the link to the server", () => {
  const ago = (minutes: number) => seconds(NOW) - minutes * 60;

  it.each([
    [{ fetchedAt: ago(0.5), staleness: "fresh" as const }, null],
    [{ fetchedAt: ago(2.9), staleness: "fresh" as const }, null],
    // Fresh by the day-long measure, but three minutes without a sync is a server not answering.
    [
      { fetchedAt: ago(3), staleness: "fresh" as const },
      { kind: "unreachable", minutes: 3 },
    ],
    [
      { fetchedAt: ago(45), staleness: "fresh" as const },
      { kind: "unreachable", minutes: 45 },
    ],
    [
      { fetchedAt: ago(26 * 60), staleness: "warn" as const },
      { kind: "stale", hours: 26 },
    ],
    [{ fetchedAt: ago(8 * 24 * 60), staleness: "expired" as const }, { kind: "expired" }],
    [{ fetchedAt: null, staleness: "unavailable" as const }, { kind: "no-list" }],
    // A clock that went backwards does not invent an outage.
    [{ fetchedAt: seconds(NOW) + 600, staleness: "fresh" as const }, null],
  ])("%j shows %j", (status, expected) => {
    expect(serverNotice(status, NOW)).toEqual(expected);
  });
});

describe("reading a pasted invite", () => {
  const invite = (origin: string, kind: "computer" | "phone" | "any" = "computer", ttl = 900) =>
    encodeInvite({
      origin,
      registryId: "abcdefgh",
      id: "AAAAAAAAAAA",
      secret: "B".repeat(22),
      kind,
      expiresAt: seconds(NOW) + ttl,
    });

  it("names the server it points at and nothing else before the user confirms", () => {
    expect(readInvite(`  ${invite("https://T3.Example.com")}\n`, NOW)).toMatchObject({
      _tag: "ready",
      host: "t3.example.com",
      punycode: null,
    });
  });

  it("shows a name written with other letters beside its ASCII form", () => {
    expect(readInvite(invite("https://tе.example.com"), NOW)).toMatchObject({
      _tag: "ready",
      host: "tе.example.com",
      punycode: expect.stringMatching(/^xn--t-/),
    });
  });

  it.each([
    ["", "empty"],
    ["hello", "invalid"],
    ["t3x1.not-base64!", "invalid"],
    [invite("https://t3.example.com", "phone"), "wrong-kind"],
    [invite("https://t3.example.com", "computer", -1), "expired"],
    [invite("http://t3.example.com"), "invalid"],
    [invite("https://t3.example.com/path"), "invalid"],
  ])("reads %s as %s", (text, tag) => {
    expect(readInvite(text, NOW)._tag).toBe(tag);
  });
});

describe("the invite deadline", () => {
  it("is a time of day for a given moment, not a countdown", () => {
    const expiresAt = seconds(NOW) + 900;
    expect(inviteDeadlineLabel(expiresAt, "en")).toBe(inviteDeadlineLabel(expiresAt, "en"));
    expect(inviteDeadlineLabel(expiresAt, "en")).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("the list of computers the connection code reads", () => {
  const snapshot = (state: "joined" | "not_joined"): DevicesSnapshot => ({
    status: {
      state,
      registryOrigin: state === "joined" ? "https://t3.example.com" : null,
      registryHost: state === "joined" ? "t3.example.com" : null,
      deviceId: "me",
      name: "Mac",
      url: null,
      tunnel: { status: "connected", lastError: null },
      fetchedAt: 1,
      staleness: "fresh",
    },
    rev: 1,
    devices: [
      { id: "me", name: "Mac", kind: "computer", createdAt: 1, lastSeenAt: 1, self: true },
      {
        id: "mini",
        name: "Mini",
        kind: "computer",
        url: "https://mini.t3.example.com",
        online: true,
        createdAt: 1,
        lastSeenAt: 1,
        self: false,
      },
      { id: "phone", name: "Pixel", kind: "phone", createdAt: 1, lastSeenAt: 1, self: false },
    ],
  });

  it("holds the computers only, pinned to the server's origin", () => {
    expect(snapshotToView(snapshot("joined"))).toEqual({
      pin: { origin: "https://t3.example.com", registryId: null },
      recordsEnvironmentIds: false,
      computers: [
        { deviceId: "me", name: "Mac", url: null, environmentId: null, self: true },
        {
          deviceId: "mini",
          name: "Mini",
          url: "https://mini.t3.example.com",
          environmentId: null,
          self: false,
          online: true,
        },
      ],
    });
  });

  it("is nothing while this computer has not joined", () => {
    expect(snapshotToView(snapshot("not_joined"))).toBeNull();
  });
});
