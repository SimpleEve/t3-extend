import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectFooterLimits,
  footerLimitSeverity,
  footerLimitsStaleAfterMs,
  mostUrgentLimit,
  tightestUsageWindow,
} from "./footerLimits.logic";

const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
  extra: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow => ({ id, kind, label: id, usedPercent, ...extra });

const CHECKED_AT = "2026-11-03T00:00:00.000Z";
const FIVE_MINUTES = 5 * 60_000;
// Just after the reading was taken, and with the default 5 minute refresh interval.
const FRESH = {
  now: Date.parse(CHECKED_AT) + 60_000,
  staleAfterMs: footerLimitsStaleAfterMs(FIVE_MINUTES),
};

const provider = (
  instanceId: string,
  windows: ServerProviderUsageWindow[],
  overrides: Record<string, unknown> = {},
) =>
  ({
    instanceId,
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    usageLimits: { checkedAt: CHECKED_AT, windows },
    ...overrides,
  }) as unknown as ServerProvider;

describe("footer limits", () => {
  it("picks the window with the least left and breaks ties toward the shorter one", () => {
    expect(tightestUsageWindow([window("w", "weekly", 42), window("s", "session", 80)])?.id).toBe(
      "s",
    );
    expect(tightestUsageWindow([window("w", "weekly", 50), window("s", "session", 50)])?.id).toBe(
      "s",
    );
    expect(tightestUsageWindow([])).toBeNull();
  });

  it("warns under 20% left and flags danger under 5%", () => {
    expect([100, 20, 19, 5, 4, 0].map(footerLimitSeverity)).toEqual([
      "ok",
      "ok",
      "warning",
      "warning",
      "danger",
      "danger",
    ]);
  });

  it("lists one entry per usable provider with remaining percent from the tightest window", () => {
    const entries = collectFooterLimits(
      [
        provider("claude", [window("w", "weekly", 30), window("s", "session", 42)]),
        provider("empty", []),
        provider("off", [window("s", "session", 10)], { enabled: false }),
        provider("failed", [window("s", "session", 10)], {
          usageLimits: {
            checkedAt: "2026-11-03T00:00:00.000Z",
            windows: [window("s", "session", 10)],
            unavailable: { reason: "probeFailed" },
          },
        }),
        provider("none", [], { usageLimits: undefined }),
      ],
      (entry) => entry.instanceId,
      FRESH,
    );
    expect(entries.map((entry) => [entry.label, entry.remaining, entry.severity])).toEqual([
      ["claude", 58, "ok"],
    ]);
    expect(entries[0]?.windows.map((entry) => entry.id)).toEqual(["s", "w"]);
  });

  it("stands the most urgent provider in for the compact chip", () => {
    const entries = collectFooterLimits(
      [provider("a", [window("s", "session", 20)]), provider("b", [window("s", "session", 97)])],
      (entry) => entry.instanceId,
      FRESH,
    );
    expect(mostUrgentLimit(entries)?.label).toBe("b");
    expect(mostUrgentLimit([])).toBeNull();
  });

  it("ignores windows that have reset and stops coloring an old reading", () => {
    const resetAt = new Date(FRESH.now - 1_000).toISOString();
    const laterAt = new Date(FRESH.now + 3_600_000).toISOString();
    const label = (entry: ServerProvider) => entry.instanceId;
    const nearlyOut = [window("s", "session", 97, { resetsAt: laterAt })];
    const sessionReset = [
      window("s", "session", 97, { resetsAt: resetAt }),
      window("w", "weekly", 40, { resetsAt: laterAt }),
    ];
    const allReset = [window("s", "session", 97, { resetsAt: resetAt })];

    // Both fine: fresh and not reset, so the tightest window decides the color.
    const [fine] = collectFooterLimits([provider("p", nearlyOut)], label, FRESH);
    expect([fine?.remaining, fine?.severity]).toEqual([3, "danger"]);

    // The session window has reset: the weekly one is the tightest, and the color follows it.
    const [partlyReset] = collectFooterLimits([provider("p", sessionReset)], label, FRESH);
    expect([partlyReset?.tightest?.id, partlyReset?.remaining, partlyReset?.severity]).toEqual([
      "w",
      60,
      "ok",
    ]);

    // Every window has reset: the entry stays, full and uncolored.
    const [fullyReset] = collectFooterLimits([provider("p", allReset)], label, FRESH);
    expect([fullyReset?.tightest, fullyReset?.remaining, fullyReset?.severity]).toEqual([
      null,
      100,
      "ok",
    ]);

    // An old reading keeps its number but not its color; twice the refresh interval is the line.
    const staleNow = Date.parse(CHECKED_AT) + 2 * FIVE_MINUTES + 1;
    const [stale] = collectFooterLimits([provider("p", nearlyOut)], label, {
      ...FRESH,
      now: staleNow,
    });
    expect([stale?.remaining, stale?.severity]).toEqual([3, "ok"]);
    const [justFresh] = collectFooterLimits([provider("p", nearlyOut)], label, {
      ...FRESH,
      now: staleNow - 1,
    });
    expect(justFresh?.severity).toBe("danger");

    // The line follows the server's refresh setting, and a refresh that is off uses the default.
    expect(footerLimitsStaleAfterMs(60_000)).toBe(120_000);
    expect(footerLimitsStaleAfterMs(0)).toBe(2 * FIVE_MINUTES);
  });
});
