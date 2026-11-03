import { describe, expect, it } from "vite-plus/test";

import type { DevicesSnapshot } from "@t3tools/contracts";

import {
  freshestStatus,
  inviteDeadlineLabel,
  serverNotice,
  serverNoticeWindow,
  snapshotToView,
} from "./deviceKeysLogic";

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

describe("which status the section trusts", () => {
  const status = (fetchedAt: number | null) =>
    ({ fetchedAt, staleness: "fresh" }) as Parameters<typeof freshestStatus>[1];

  it.each([
    // The registry answered "no change" after the stream last pushed: the query's copy is newer.
    [status(100), status(500), 500],
    [status(500), status(100), 500],
    [undefined, status(100), 100],
    [status(null), status(100), 100],
    [status(100), status(null), 100],
  ])("takes the later sync of %j and %j", (streamed, queried, expected) => {
    expect(freshestStatus(streamed, queried).fetchedAt).toBe(expected);
  });
});

describe("the invite deadline", () => {
  it("is a zero-padded 24-hour time of day, not a countdown", () => {
    // Local time: 01:14 must not read as 1:14, which could be either half of the day.
    const local = new Date(2026, 10, 3, 1, 14, 0);
    expect(inviteDeadlineLabel(Math.floor(local.getTime() / 1000), "en")).toBe("01:14");
    expect(inviteDeadlineLabel(Math.floor(local.getTime() / 1000), "zh-CN")).toBe("01:14");
    const evening = new Date(2026, 10, 3, 13, 5, 0);
    expect(inviteDeadlineLabel(Math.floor(evening.getTime() / 1000), "en")).toBe("13:05");
  });
});

describe("when the server notice changes", () => {
  const status = (
    fetchedAt: number | null,
    staleness: "fresh" | "warn" | "expired" | "unavailable",
  ) => ({ fetchedAt, staleness }) as const;
  const synced = seconds(NOW);

  it.each([
    [status(synced, "fresh"), "fresh"],
    [status(synced, "warn"), "warn"],
    [status(synced, "expired"), "expired"],
    [status(null, "unavailable"), "none"],
  ])("%j: the window start reads like the moment itself, and its end is the next change", (st) => {
    for (let offsetSeconds = 0; offsetSeconds < 3 * 3600; offsetSeconds += 7) {
      const nowMs = NOW + offsetSeconds * 1000;
      const window = serverNoticeWindow(st, nowMs);
      expect(serverNotice(st, window.startMs)).toEqual(serverNotice(st, nowMs));
      if (window.endMs !== null) {
        expect(window.endMs).toBeGreaterThan(nowMs);
        expect(serverNotice(st, window.endMs)).not.toEqual(serverNotice(st, nowMs));
      }
    }
  });

  it("is quiet until three minutes after the sync, then moves every minute", () => {
    const st = status(synced, "fresh");
    expect(serverNoticeWindow(st, NOW).endMs).toBe(NOW + 180_000);
    expect(serverNoticeWindow(st, NOW + 181_000)).toEqual({
      startMs: NOW + 180_000,
      endMs: NOW + 240_000,
    });
  });

  it("never changes once the list has no sync to measure from", () => {
    expect(serverNoticeWindow(status(null, "unavailable"), NOW).endMs).toBeNull();
    expect(serverNoticeWindow(status(synced, "expired"), NOW).endMs).toBeNull();
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
