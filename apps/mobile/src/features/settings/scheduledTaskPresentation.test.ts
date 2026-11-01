import { loadUiCatalog } from "@t3tools/client-runtime/i18n";
import { describe, expect, it } from "vite-plus/test";

import { formatNextScheduledTaskRun } from "./scheduledTaskPresentation";

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
