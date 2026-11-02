import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPushPayload,
  decideThreadAlert,
  preferenceAllows,
  TERMINAL_NOTIFICATION_FRESHNESS_MS,
  type PhaseMemory,
} from "./pushTriggers.ts";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + offsetMs));
const ALL_ON = {
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

describe("decideThreadAlert", () => {
  const phases = [
    ["waiting_for_approval", "approval"],
    ["waiting_for_input", "input"],
    ["completed", "completed"],
    ["failed", "failed"],
  ] as const;

  it.each(phases)("alerts when a thread moves into %s", (phase, kind) => {
    expect(
      decideThreadAlert({
        previous: "running",
        next: { phase, updatedAt: at(-1_000) },
        nowMs: NOW,
      }),
    ).toEqual({ memory: phase, kind });
  });

  it.each(["running", "starting", "stale"] as const)("never alerts for %s", (phase) => {
    expect(
      decideThreadAlert({ previous: "none", next: { phase, updatedAt: at(0) }, nowMs: NOW }).kind,
    ).toBeNull();
  });

  it("does not alert again while a thread stays in the same phase", () => {
    expect(
      decideThreadAlert({
        previous: "waiting_for_approval",
        next: { phase: "waiting_for_approval", updatedAt: at(0) },
        nowMs: NOW,
      }).kind,
    ).toBeNull();
  });

  it("alerts again when the thread re-enters a phase after leaving it", () => {
    const afterRunning = decideThreadAlert({
      previous: "running" satisfies PhaseMemory,
      next: { phase: "waiting_for_approval", updatedAt: at(0) },
      nowMs: NOW,
    });
    expect(afterRunning.kind).toBe("approval");
  });

  it("treats a cleared state as leaving the phase", () => {
    expect(decideThreadAlert({ previous: "completed", next: null, nowMs: NOW })).toEqual({
      memory: "none",
      kind: null,
    });
  });

  it("skips finished runs older than the freshness window but not attention requests", () => {
    const stale = at(-TERMINAL_NOTIFICATION_FRESHNESS_MS - 1);
    expect(
      decideThreadAlert({
        previous: "none",
        next: { phase: "completed", updatedAt: stale },
        nowMs: NOW,
      }).kind,
    ).toBeNull();
    expect(
      decideThreadAlert({
        previous: "none",
        next: { phase: "failed", updatedAt: stale },
        nowMs: NOW,
      }).kind,
    ).toBeNull();
    expect(
      decideThreadAlert({
        previous: "none",
        next: { phase: "waiting_for_input", updatedAt: stale },
        nowMs: NOW,
      }).kind,
    ).toBe("input");
  });
});

describe("preferenceAllows", () => {
  it("applies each per-device switch and the master switch", () => {
    expect(preferenceAllows(ALL_ON, "completed")).toBe(true);
    expect(preferenceAllows({ ...ALL_ON, notifyOnCompletion: false }, "completed")).toBe(false);
    expect(preferenceAllows({ ...ALL_ON, notifyOnCompletion: false }, "failed")).toBe(true);
    expect(preferenceAllows({ ...ALL_ON, notifyOnApproval: false }, "approval")).toBe(false);
    expect(preferenceAllows({ ...ALL_ON, notifyOnInput: false }, "input")).toBe(false);
    expect(preferenceAllows({ ...ALL_ON, notifyOnFailure: false }, "failed")).toBe(false);
    expect(preferenceAllows({ ...ALL_ON, notificationsEnabled: false }, "approval")).toBe(false);
  });

  it("always lets a test notification through", () => {
    expect(
      preferenceAllows(
        {
          notificationsEnabled: false,
          notifyOnApproval: false,
          notifyOnInput: false,
          notifyOnCompletion: false,
          notifyOnFailure: false,
        },
        "test",
      ),
    ).toBe(true);
  });
});

describe("buildPushPayload", () => {
  const base = {
    kind: "completed",
    environmentId: "env-1",
    environmentLabel: "Mac mini",
    threadId: "thread-1",
    threadTitle: "T".repeat(500),
    projectTitle: "Project",
    updatedAt: "2026-11-02T11:59:30.000Z",
    nowMs: NOW,
  } as const;

  it("keeps one alert's id stable and distinguishes alerts", () => {
    expect(buildPushPayload(base).id).toBe(buildPushPayload(base).id);
    expect(buildPushPayload({ ...base, kind: "failed" }).id).not.toBe(buildPushPayload(base).id);
    expect(buildPushPayload({ ...base, updatedAt: "2026-11-02T11:59:31.000Z" }).id).not.toBe(
      buildPushPayload(base).id,
    );
  });

  it("bounds titles so a payload always fits one push message", () => {
    expect(buildPushPayload(base).threadTitle.length).toBe(120);
    expect(JSON.stringify(buildPushPayload(base)).length).toBeLessThan(1_000);
  });
});
