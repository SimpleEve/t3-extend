import { setUiLocale } from "@t3tools/client-runtime/i18n";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildPushTemplates } from "./pushTemplates";

afterEach(() => setUiLocale("en"));

describe("buildPushTemplates", () => {
  it("keeps the receiver's placeholders and the English source by default", () => {
    const templates = JSON.parse(buildPushTemplates("en"));
    expect(templates.approval).toEqual({
      title: "{thread}",
      body: "Approval needed · {project} · {environment}",
    });
    expect(templates.test.title).toBe("T3 Extend test notification");
    expect(templates.test.body).toBe("Notifications from {environment} reach this phone.");
  });

  it("formats from the catalog of the requested language and keeps the placeholders", async () => {
    await setUiLocale("zh-Hans");
    const templates = JSON.parse(buildPushTemplates("zh-Hans"));
    expect(templates.approval.body).toBe("需要批准 · {project} · {environment}");
    expect(templates.input.body).toBe("需要你回答 · {project} · {environment}");
    expect(templates.completed.body).toBe("已完成 · {project} · {environment}");
    expect(templates.test.body).toBe("{environment} 的通知能送达这部手机。");
    expect(templates.channelName).toBe("Agent 提醒");
  });
});
