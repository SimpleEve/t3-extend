import { describe, expect, it } from "vite-plus/test";

import type { DevicesSnapshot } from "@t3tools/contracts";

import {
  describeVisibility,
  describeVisibilityDetail,
  describeVisibilityRegistry,
  describeVisibilityShort,
  deviceSeesThisComputer,
  inviteDeadlineLabel,
  networkAccessNeedsRefresh,
  serverNotice,
  serverNoticeWindow,
  snapshotToView,
  visibilityDraftReady,
  visibilityLimited,
  visibilityToSend,
  visibilityUnchanged,
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

describe("when the desktop app's pairing addresses are read again", () => {
  it.each([
    // Nothing seen yet: the settings page loads them itself.
    [null, "disabled", false],
    [null, "connected", false],
    // Joining and leaving move the tunnel across "disabled".
    ["disabled", "connecting", true],
    ["disabled", "connected", true],
    ["connected", "disabled", true],
    ["error", "disabled", true],
    // Reaching or leaving "connected" flips whether the address is vouched for.
    ["connecting", "connected", true],
    ["connected", "error", true],
    ["connected", "connecting", true],
    // Moving between the other live states changes nothing.
    ["stopped", "connecting", false],
    ["connecting", "error", false],
    ["connected", "connected", false],
    ["disabled", "disabled", false],
  ] as const)("%s then %s reads again: %s", (previous, next, expected) => {
    expect(networkAccessNeedsRefresh(previous, next)).toBe(expected);
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

describe("the Visibility setting", () => {
  const t = ((source: string, params?: Record<string, unknown>) =>
    source.replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? ""))) as never;
  const devices = [
    { id: "a", name: "Laptop" },
    { id: "b", name: "Pixel" },
  ];

  it("needs a pick for the two modes that name devices, and only those", () => {
    expect(visibilityDraftReady({ mode: "visible_to_all", deviceIds: [] })).toBe(true);
    expect(visibilityDraftReady({ mode: "hidden_from_all", deviceIds: [] })).toBe(true);
    expect(visibilityDraftReady({ mode: "hidden_from_selected", deviceIds: [] })).toBe(false);
    expect(visibilityDraftReady({ mode: "visible_to_selected", deviceIds: ["a"] })).toBe(true);
  });

  it("sends no list for the modes that name nobody, and a sorted one for the rest", () => {
    expect(visibilityToSend({ mode: "hidden_from_all", deviceIds: ["a"] })).toEqual({
      mode: "hidden_from_all",
      deviceIds: [],
    });
    expect(visibilityToSend({ mode: "hidden_from_selected", deviceIds: ["b", "a", "b"] })).toEqual({
      mode: "hidden_from_selected",
      deviceIds: ["a", "b"],
    });
  });

  it("knows when the draft is what is already saved", () => {
    const saved = {
      mode: "hidden_from_selected" as const,
      deviceIds: ["a", "b"],
      registry: "synced" as const,
    };
    expect(
      visibilityUnchanged({ mode: "hidden_from_selected", deviceIds: ["b", "a"] }, saved),
    ).toBe(true);
    expect(visibilityUnchanged({ mode: "hidden_from_selected", deviceIds: ["a"] }, saved)).toBe(
      false,
    );
    expect(visibilityUnchanged({ mode: "visible_to_selected", deviceIds: ["a", "b"] }, saved)).toBe(
      false,
    );
  });

  it("describes who can see this computer, counting devices that are not on the list by their id", () => {
    expect(describeVisibility(t, { mode: "visible_to_all", deviceIds: [] }, devices)).toBe(
      "Visible to all devices.",
    );
    expect(
      describeVisibility(t, { mode: "hidden_from_selected", deviceIds: ["a", "b"] }, devices),
    ).toBe("Hidden from Laptop, Pixel.");
    expect(describeVisibility(t, { mode: "visible_to_selected", deviceIds: ["a"] }, devices)).toBe(
      "Visible only to Laptop.",
    );
    expect(
      describeVisibility(
        t,
        { mode: "hidden_from_selected", deviceIds: ["a", "unseen-0123456789"] },
        devices,
      ),
    ).toBe("Hidden from Laptop, unseen-0….");
    expect(describeVisibility(t, { mode: "hidden_from_selected", deviceIds: [] }, devices)).toBe(
      "Hidden from the devices you chose.",
    );
  });

  it("says the active mode in a few words, naming one or two short device names and counting the rest", () => {
    const short = (mode: Parameters<typeof describeVisibilityShort>[1]["mode"], ids: string[]) =>
      describeVisibilityShort(t, { mode, deviceIds: ids }, devices);
    expect(short("visible_to_all", [])).toBe("Visible to all devices");
    expect(short("hidden_from_all", [])).toBe("Hidden from all devices");
    expect(short("hidden_from_selected", ["a"])).toBe("Hidden from Laptop");
    expect(short("hidden_from_selected", ["a", "b"])).toBe("Hidden from Laptop, Pixel");
    expect(short("visible_to_selected", ["b"])).toBe("Visible only to Pixel");
    // An id that is not on the list has no name to show, so it is counted.
    expect(short("hidden_from_selected", ["a", "unseen-0123456789"])).toBe("Hidden from 2 devices");
    expect(short("visible_to_selected", ["unseen-0123456789"])).toBe("Visible only to 1 device");
    // Three or more, or names too long for one line, are counted too.
    const many = [
      { id: "a", name: "Laptop" },
      { id: "b", name: "Pixel" },
      { id: "c", name: "iPad" },
      { id: "d", name: "A very long device name" },
    ];
    expect(
      describeVisibilityShort(
        t,
        { mode: "hidden_from_selected", deviceIds: ["a", "b", "c"] },
        many,
      ),
    ).toBe("Hidden from 3 devices");
    expect(
      describeVisibilityShort(t, { mode: "visible_to_selected", deviceIds: ["d"] }, many),
    ).toBe("Visible only to 1 device");
    expect(
      describeVisibilityShort(
        t,
        { mode: "hidden_from_all", deviceIds: [], unreadable: true },
        devices,
      ),
    ).toBe("Setting unreadable");
  });

  it("marks only the settings that keep this computer from someone", () => {
    expect(visibilityLimited({ mode: "visible_to_all" })).toBe(false);
    expect(visibilityLimited({ mode: "hidden_from_all" })).toBe(true);
    expect(visibilityLimited({ mode: "hidden_from_selected" })).toBe(true);
    expect(visibilityLimited({ mode: "visible_to_selected" })).toBe(true);
    // The saved mode of an unreadable file is a guess, but the refusal is real.
    expect(visibilityLimited({ mode: "visible_to_all", unreadable: true })).toBe(true);
  });

  it("knows which listed devices cannot see this computer", () => {
    const sees = (mode: Parameters<typeof deviceSeesThisComputer>[0]["mode"], id: string) =>
      deviceSeesThisComputer({ mode, deviceIds: ["a"] }, id);
    expect(sees("visible_to_all", "a")).toBe(true);
    expect(sees("hidden_from_all", "b")).toBe(false);
    expect(sees("hidden_from_selected", "a")).toBe(false);
    expect(sees("hidden_from_selected", "b")).toBe(true);
    expect(sees("visible_to_selected", "a")).toBe(true);
    expect(sees("visible_to_selected", "b")).toBe(false);
    expect(
      deviceSeesThisComputer({ mode: "visible_to_all", deviceIds: [], unreadable: true }, "a"),
    ).toBe(false);
  });

  it("uses the refusal as the tooltip sentence when the setting is unreadable", () => {
    expect(
      describeVisibilityDetail(
        t,
        { mode: "visible_to_all", deviceIds: [], unreadable: true },
        devices,
      ),
    ).toMatch(/could not be read/);
    expect(describeVisibilityDetail(t, { mode: "hidden_from_all", deviceIds: [] }, devices)).toBe(
      "Hidden from all devices, including ones that join later.",
    );
  });

  it("offers a save for a setting that could not be read, even when the options look the same", () => {
    const saved = { mode: "hidden_from_all", deviceIds: [], registry: "synced" } as const;
    expect(visibilityUnchanged({ mode: "hidden_from_all", deviceIds: [] }, saved)).toBe(true);
    expect(
      visibilityUnchanged(
        { mode: "hidden_from_all", deviceIds: [] },
        { ...saved, unreadable: true },
      ),
    ).toBe(false);
  });

  it("only speaks up about the server when it has not got the setting", () => {
    expect(describeVisibilityRegistry(t, "synced")).toBeNull();
    expect(describeVisibilityRegistry(t, "unknown")).toBeNull();
    expect(describeVisibilityRegistry(t, "unsupported")).toMatch(/needs an update/);
    expect(describeVisibilityRegistry(t, "pending")).toMatch(/has not received/);
  });
});
