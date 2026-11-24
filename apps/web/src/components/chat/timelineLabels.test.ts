import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";
import { describe, expect, it } from "vite-plus/test";

import { translateTimelineLabel } from "./timelineLabels";

describe("translateTimelineLabel", () => {
  it("translates the row logic's labels as whole phrases and keeps their values", async () => {
    await loadUiCatalog("zh-Hans");
    const t = translatorFor("zh-Hans");
    expect(translateTimelineLabel("Worked for 2m 5s", t)).toBe("工作了 2m 5s");
    expect(translateTimelineLabel("You stopped after 12s", t)).toBe("你在 12s 后停止了");
    expect(translateTimelineLabel("Context compacted 120k → 8k tokens", t)).toBe(
      "上下文已压缩：120k → 8k token",
    );
    expect(translateTimelineLabel("Worked", t)).toBe("已工作");
    // Unknown text, such as a provider's own title, shows as sent.
    expect(translateTimelineLabel("Worked on the parser", t)).toBe("Worked on the parser");
    expect(translateTimelineLabel("Worked for 2m 5s", translatorFor("en"))).toBe(
      "Worked for 2m 5s",
    );
  });
});
