import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";
import { formatResetDuration, formatResetsInShort } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const window = {
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 40,
  windowDurationMins: 10_080,
  resetsAt: "2026-09-08T21:30:00.000Z",
} as const;

describe("usage reset labels", () => {
  it("translates duration units through the Resets row's context translator", async () => {
    await loadUiCatalog("zh-Hans");
    const t = translatorFor("zh-Hans");
    const row = (source: string, params?: Readonly<Record<string, string>>) =>
      t(source, params, "resets row");
    expect(formatResetsInShort(window, now, row)).toBe("5 天 9 小时后");
    expect(formatResetsInShort({ ...window, resetsAt: "2026-09-03T11:00:00.000Z" }, now, row)).toBe(
      "现在",
    );
    expect(formatResetDuration(window, now, t)).toBe("5 天 9 小时");
  });
});
