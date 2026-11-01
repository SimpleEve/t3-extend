import { getUiLocale } from "@t3tools/client-runtime/i18n";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { startUiLanguage } from "./uiLanguage";

const env = vi.hoisted(() => ({
  listeners: [] as Array<() => void>,
  toasts: [] as Array<{ title?: unknown; actionProps?: { children?: unknown } }>,
}));

// Module-wide, so it lives apart from uiLanguage.test.ts: the catalog chunk is unreachable.
vi.mock("../../../packages/client-runtime/src/i18n/catalogs/zh-Hans/index.ts", () => {
  throw new Error("chunk failed to load");
});

vi.mock("./hooks/useSettings", () => ({
  ensureClientSettingsHydrated: () => Promise.resolve(),
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "zh-Hans" }),
  subscribeClientSettings: (listener: () => void) => {
    env.listeners.push(listener);
    return () => undefined;
  },
}));

vi.mock("./components/ui/toast", () => ({
  toastManager: { add: (toast: (typeof env.toasts)[number]) => env.toasts.push(toast) },
}));

function setup() {
  env.listeners.length = 0;
  env.toasts.length = 0;
  vi.stubGlobal("document", { documentElement: { lang: "" } });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("navigator", { languages: [] });
  return {
    [Symbol.dispose]() {
      vi.unstubAllGlobals();
    },
  };
}

describe("startUiLanguage when the catalog fails to load", () => {
  it("stays in English and offers one reload, even as later settings changes reapply it", async () => {
    using _env = setup();
    await startUiLanguage({ isReloadScheduled: () => false }).settled;
    expect(getUiLocale()).toBe("en");
    expect(env.toasts).toEqual([
      expect.objectContaining({ actionProps: expect.objectContaining({ children: "Reload" }) }),
    ]);

    env.listeners[0]!();
    await vi.dynamicImportSettled();
    expect(getUiLocale()).toBe("en");
    expect(env.toasts).toHaveLength(1);
  });

  it("stays quiet while a chunk-error reload is already on its way", async () => {
    using _env = setup();
    await startUiLanguage({ isReloadScheduled: () => true }).settled;
    expect(getUiLocale()).toBe("en");
    expect(env.toasts).toEqual([]);
  });
});
