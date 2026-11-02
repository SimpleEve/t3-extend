import { loadUiCatalog, setUiLocale } from "@t3tools/client-runtime/i18n";
import { describe, expect, it } from "vite-plus/test";

import {
  formatNextScheduledTaskRun,
  formatScheduledTaskInterval,
} from "./scheduledTaskPresentation";

describe("formatNextScheduledTaskRun", () => {
  const now = new Date(2026, 0, 1, 12, 0).getTime();
  const tomorrowNine = new Date(2026, 0, 2, 9, 0).toISOString();

  it("formats the time in the interface language, not the device locale", async () => {
    await loadUiCatalog("zh-Hans");
    // ICU puts a plain or a no-break space before "AM" depending on its version.
    expect(formatNextScheduledTaskRun(tomorrowNine, now, "en")).toMatch(
      /^Next run tomorrow at 9:00\s+AM$/u,
    );
    expect(formatNextScheduledTaskRun(tomorrowNine, now, "zh-Hans")).toBe("明天 9:00 运行");
    expect(formatNextScheduledTaskRun(new Date(now + 2 * 60_000).toISOString(), now, "en")).toBe(
      "Next run in 2 minutes",
    );
  });
});

describe("formatScheduledTaskInterval", () => {
  const HOUR = 3_600_000;

  it.each([
    [HOUR, "Every hour"],
    [2 * HOUR, "Every 2 hours"],
    [HOUR + 30 * 60_000, "Every 1 hour 30 minutes"],
    [24 * HOUR, "Every day"],
  ])("keeps the English for %i ms", (everyMs, expected) => {
    expect(formatScheduledTaskInterval(everyMs)).toBe(expected);
  });

  it("translates the whole phrase", async () => {
    await setUiLocale("zh-Hans");
    try {
      expect(formatScheduledTaskInterval(HOUR)).toBe("每小时");
      expect(formatScheduledTaskInterval(HOUR + 30 * 60_000)).toBe("每 1 小时 30 分钟");
    } finally {
      await setUiLocale("en");
    }
  });
});
