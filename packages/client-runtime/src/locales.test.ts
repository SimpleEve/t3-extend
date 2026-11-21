import { describe, expect, it } from "vite-plus/test";

import { resolveLocaleSelection, SYSTEM_LANGUAGE } from "./locales.ts";

const SUPPORTED = ["en", "es", "zh", "pt-BR", "fr", "de", "ja", "ko", "ru", "sv"];

describe("resolveLocaleSelection", () => {
  // Android reports `zh-Hans-CN`, macOS `zh-Hans-CN` or `zh-CN`; all are our Simplified `zh`.
  it.each(["zh-Hans-CN", "zh-CN", "zh_CN", "zh"])(
    "follows a %s system with System default",
    (tag) => {
      expect(resolveLocaleSelection(SYSTEM_LANGUAGE, [tag], SUPPORTED, "en").catalogLocale).toBe(
        "zh",
      );
    },
  );

  it("keeps the system tag for regional formats", () => {
    expect(resolveLocaleSelection(SYSTEM_LANGUAGE, ["zh-Hans-CN"], SUPPORTED, "en")).toEqual({
      catalogLocale: "zh",
      formattingLocale: "zh-Hans-CN",
    });
  });

  it("does not take Traditional Chinese for Simplified", () => {
    expect(resolveLocaleSelection(SYSTEM_LANGUAGE, ["zh-TW"], SUPPORTED, "en").catalogLocale).toBe(
      "en",
    );
  });

  it("prefers a saved language over the system's", () => {
    expect(resolveLocaleSelection("zh", ["en-US"], SUPPORTED, "en").catalogLocale).toBe("zh");
  });
});
