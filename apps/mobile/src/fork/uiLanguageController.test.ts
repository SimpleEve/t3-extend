import type { UiLocale } from "@t3tools/client-runtime/i18n";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  androidLocaleTag,
  createUiLanguageController,
  FIRST_FRAME_LANGUAGE_WAIT_MS,
} from "./uiLanguageController";

function fakeLocales() {
  let current: UiLocale = "en";
  const pending = new Map<UiLocale, (loaded: boolean) => void>();
  const setLocale = vi.fn(
    (locale: UiLocale) =>
      new Promise<void>((resolve) => {
        pending.set(locale, (loaded) => {
          if (loaded) current = locale;
          resolve();
        });
      }),
  );
  return {
    deps: { setLocale, currentLocale: () => current },
    setLocale,
    finish: (locale: UiLocale, loaded: boolean) => pending.get(locale)?.(loaded),
  };
}

describe("androidLocaleTag", () => {
  it.each([
    ["zh_CN_#Hans", "zh-CN-Hans"],
    ["zh__#Hant", "zh-Hant"],
    ["zh_TW", "zh-TW"],
    ["en_US", "en-US"],
    ["zh", "zh"],
  ])("turns %s into %s", (identifier, tag) => {
    expect(androidLocaleTag(identifier)).toBe(tag);
  });
});

describe("createUiLanguageController", () => {
  it("is ready at once for English", () => {
    const locales = fakeLocales();
    const controller = createUiLanguageController(locales.deps);
    controller.apply("system", ["en-US"]);
    expect(controller.isReady()).toBe(true);
    expect(locales.setLocale).toHaveBeenCalledWith("en");
  });

  it("waits for the Chinese catalog before the first frame", async () => {
    const locales = fakeLocales();
    const controller = createUiLanguageController(locales.deps);
    const onReady = vi.fn();
    controller.subscribeReady(onReady);

    controller.apply("system", ["zh-Hans-CN"]);
    expect(locales.setLocale).toHaveBeenCalledWith("zh-Hans");
    expect(controller.isReady()).toBe(false);

    locales.finish("zh-Hans", true);
    await vi.waitFor(() => expect(controller.isReady()).toBe(true));
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a stalled catalog after the cap", () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    const locales = fakeLocales();
    const controller = createUiLanguageController(locales.deps);

    controller.apply("zh-Hans", []);
    vi.advanceTimersByTime(FIRST_FRAME_LANGUAGE_WAIT_MS - 1);
    expect(controller.isReady()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.isReady()).toBe(true);
  });

  it("stays in English and becomes ready when the catalog fails to load", async () => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const locales = fakeLocales();
    const controller = createUiLanguageController(locales.deps);

    controller.apply("zh-Hans", []);
    locales.finish("zh-Hans", false);
    await vi.waitFor(() => expect(controller.isReady()).toBe(true));
    expect(locales.deps.currentLocale()).toBe("en");
  });

  it("applies a changed setting and skips repeats of the same one", () => {
    const locales = fakeLocales();
    const controller = createUiLanguageController(locales.deps);
    controller.apply("en", ["zh-CN"]);
    controller.apply("en", ["zh-CN"]);
    controller.apply("system", ["zh-CN"]);
    expect(locales.setLocale.mock.calls).toEqual([["en"], ["zh-Hans"]]);
  });
});
