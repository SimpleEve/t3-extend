import { getUiLocale, loadUiCatalog, setUiLocale } from "@t3tools/client-runtime/i18n";
import { DEFAULT_CLIENT_SETTINGS, type UiLanguageSetting } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { FIRST_PAINT_LANGUAGE_WAIT_MS, startUiLanguage } from "./uiLanguage";

const settings = vi.hoisted(() => ({
  uiLanguage: "en" as UiLanguageSetting,
  hydrated: Promise.resolve(),
  listeners: [] as Array<() => void>,
}));

vi.mock("./hooks/useSettings", () => ({
  ensureClientSettingsHydrated: () => settings.hydrated,
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: settings.uiLanguage }),
  subscribeClientSettings: (listener: () => void) => {
    settings.listeners.push(listener);
    return () => undefined;
  },
}));

async function setup(hydrated: Promise<void>) {
  settings.uiLanguage = "zh-Hans";
  settings.hydrated = hydrated;
  settings.listeners.length = 0;
  // Preloaded so applying Chinese settles in microtasks, not on a module-loader timer.
  await loadUiCatalog("zh-Hans");
  await setUiLocale("en");
  const root = { lang: "" };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("navigator", { languages: [] });
  vi.useFakeTimers();
  return {
    root,
    [Symbol.dispose]() {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

describe("startUiLanguage", () => {
  it("paints in the saved language without waiting on the timer when settings read quickly", async () => {
    using env = await setup(Promise.resolve());
    await startUiLanguage();
    expect(getUiLocale()).toBe("zh-Hans");
    expect(env.root.lang).toBe("zh-Hans");
  });

  it("stops holding first paint after the wait, then switches when settings arrive", async () => {
    let finishHydration!: () => void;
    using env = await setup(new Promise((resolve) => (finishHydration = resolve)));
    let painted = false;
    const ready = startUiLanguage().then(() => (painted = true));

    await vi.advanceTimersByTimeAsync(FIRST_PAINT_LANGUAGE_WAIT_MS - 1);
    expect(painted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await ready;
    expect(getUiLocale()).toBe("en");
    expect(settings.listeners).toHaveLength(0);

    finishHydration();
    await vi.advanceTimersByTimeAsync(0);
    expect(getUiLocale()).toBe("zh-Hans");
    expect(env.root.lang).toBe("zh-Hans");
    expect(settings.listeners).toHaveLength(1);
    expect(window.addEventListener).toHaveBeenCalledWith("languagechange", expect.any(Function));

    settings.uiLanguage = "en";
    settings.listeners[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(getUiLocale()).toBe("en");
  });
});
