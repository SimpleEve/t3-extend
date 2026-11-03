import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectFooterLimits,
  footerLimitSeverity,
  mostUrgentLimit,
  tightestUsageWindow,
} from "./footerLimits.logic";

const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
  extra: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow => ({ id, kind, label: id, usedPercent, ...extra });

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
    usageLimits: { checkedAt: "2026-11-03T00:00:00.000Z", windows },
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
    );
    expect(mostUrgentLimit(entries)?.label).toBe("b");
    expect(mostUrgentLimit([])).toBeNull();
  });
});
