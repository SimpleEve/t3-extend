import { describe, expect, it } from "vite-plus/test";

import {
  formatNextScheduledTaskRun,
  formatScheduledTaskInterval,
} from "./scheduledTaskPresentation";

describe("formatNextScheduledTaskRun", () => {
  const now = new Date(2026, 0, 1, 12, 0).getTime();
  const tomorrowNine = new Date(2026, 0, 2, 9, 0).toISOString();

  it("formats Chinese as a 24-hour time and keeps the device locale for English", async () => {
    await loadUiCatalog("zh-Hans");
    const deviceTime = new Date(tomorrowNine).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(formatNextScheduledTaskRun(tomorrowNine, now, "en")).toBe(
      `Next run tomorrow at ${deviceTime}`,
    );
    expect(formatNextScheduledTaskRun(tomorrowNine, now, "zh-Hans")).toBe("明天 9:00 运行");
    const tomorrowNinePm = new Date(2026, 0, 2, 21, 0).toISOString();
    expect(formatNextScheduledTaskRun(tomorrowNinePm, now, "zh-Hans")).toBe("明天 21:00 运行");
    expect(formatNextScheduledTaskRun(new Date(now + 2 * 60_000).toISOString(), now, "en")).toBe(
      "Next run in 2 minutes",
    );
  });
});

describe("formatNextScheduledTaskRun rounding", () => {
  it("names the rounded unit for a run later today", () => {
    const now = new Date(2026, 10, 3, 10, 0, 0).getTime();
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    expect(formatNextScheduledTaskRun(at(59), now, "en")).toBe("Next run in 59 minutes");
    expect(formatNextScheduledTaskRun(at(59.5), now, "en")).toBe("Next run in 1 hour");
    expect(formatNextScheduledTaskRun(at(150), now, "en")).toBe("Next run in 3 hours");
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
    expect(formatScheduledTaskInterval(everyMs, translatorFor("en"))).toBe(expected);
  });

  it("translates the whole phrase", async () => {
    await loadUiCatalog("zh-Hans");
    const zh = translatorFor("zh-Hans");
    expect(formatScheduledTaskInterval(HOUR, zh)).toBe("每小时");
    expect(formatScheduledTaskInterval(HOUR + 30 * 60_000, zh)).toBe("每 1 小时 30 分钟");
  });
});
