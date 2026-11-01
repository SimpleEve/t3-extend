import { describe, expect, it, vi } from "vite-plus/test";

import { getUiLocale, setUiLocale, subscribeUiLocale } from "./store.ts";

const catalogImport = vi.hoisted(() => ({ attempts: 0 }));

// Module-wide, so it lives apart from i18n.test.ts: the first import fails as an unreachable chunk would.
vi.mock("./catalogs/zh-Hans/index.ts", () => {
  catalogImport.attempts += 1;
  if (catalogImport.attempts === 1) throw new Error("chunk failed to load");
  return { default: { Settings: "设置" } };
});

describe("UI locale store when a catalog fails to load", () => {
  it("keeps the current locale, tells no one, and imports again on the next request", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeUiLocale(() => seen.push(getUiLocale()));
    await setUiLocale("zh-Hans");
    expect(getUiLocale()).toBe("en");
    expect(seen).toEqual([]);

    await setUiLocale("zh-Hans");
    expect(catalogImport.attempts).toBe(2);
    expect(getUiLocale()).toBe("zh-Hans");
    expect(seen).toEqual(["zh-Hans"]);
    unsubscribe();
  });
});
