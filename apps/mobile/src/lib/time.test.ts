import { describe, expect, it } from "vite-plus/test";
import {
  messageTimeLabel,
  msUntilRelativeTimeChange,
  relativeTime,
  uiFormatLocale,
  uiFormatOptions,
} from "./time";

const at = "2026-10-19T12:00:00.000Z";
const timestamp = Date.parse(at);

describe("relative time", () => {
  it.each([
    [59_999, "<1m", "1m"],
    [119_999, "1m", "2m"],
    [3_599_999, "59m", "1h"],
    [7_199_999, "1h", "2h"],
    [86_399_999, "23h", "1d"],
    [172_799_999, "1d", "2d"],
  ] as const)("updates at the next boundary after %i ms", (elapsed, before, after) => {
    const nowMs = timestamp + elapsed;
    expect(relativeTime(at, nowMs)).toBe(before);
    expect(msUntilRelativeTimeChange(at, nowMs)).toBe(1);
    expect(relativeTime(at, nowMs + 1)).toBe(after);
  });

  it.each([
    [0, 60_000],
    [60_000, 60_000],
    [3_600_000, 3_600_000],
    [86_400_000, 86_400_000],
  ])("waits a full label interval at %i ms", (elapsed, delay) => {
    expect(msUntilRelativeTimeChange(at, timestamp + elapsed)).toBe(delay);
  });

  it("keeps invalid timestamps static", () => {
    expect(relativeTime("invalid", timestamp)).toBe("<1m");
    expect(msUntilRelativeTimeChange("invalid", timestamp)).toBeNull();
  });

  it("waits until a future timestamp is a minute old, with bounded timers", () => {
    expect(relativeTime(at, timestamp - 30_000)).toBe("<1m");
    expect(msUntilRelativeTimeChange(at, timestamp - 30_000)).toBe(90_000);
    expect(msUntilRelativeTimeChange(at, timestamp - 30 * 86_400_000)).toBe(86_400_000);
  });
});

describe("messageTimeLabel", () => {
  it("formats the clock time in the interface language", () => {
    const afternoon = new Date(2026, 0, 2, 15, 7).getTime();
    expect(messageTimeLabel(afternoon, "en")).toBe(
      new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(afternoon),
    );
    expect(messageTimeLabel(afternoon, "zh-Hans")).toBe("15:07");
  });
});

describe("uiFormatLocale", () => {
  it("keeps the device locale for English and forces a 24-hour clock for Chinese", () => {
    const options = { hour: "numeric", minute: "2-digit" } as const;
    expect(uiFormatLocale("en")).toBeUndefined();
    expect(uiFormatOptions("en", options)).toEqual(options);
    expect(uiFormatLocale("zh-Hans")).toBe("zh-CN");
    expect(uiFormatOptions("zh-Hans", options)).toEqual({ ...options, hour12: false });
    const evening = new Date(2026, 0, 2, 21, 5);
    expect(
      evening.toLocaleTimeString(uiFormatLocale("zh-Hans"), uiFormatOptions("zh-Hans", options)),
    ).toBe("21:05");
    // A 12-hour device clock still applies in English but not in Chinese.
    const deviceClock = { ...options, hourCycle: "h12" } as const;
    expect(uiFormatOptions("en", deviceClock)).toEqual(deviceClock);
    expect(uiFormatOptions("zh-Hans", deviceClock)).toEqual({ ...options, hour12: false });
  });
});
