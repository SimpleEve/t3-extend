import { describe, expect, it } from "vite-plus/test";

import { ZH_HANS_AREAS } from "./catalogs/zh-Hans/index.ts";
import { uiLocaleForLanguage } from "./locale.ts";
import { formatCompactElapsedLabel, formatRelativeElapsedLabel } from "./relativeTime.ts";
import { getUiLocale, setUiLocale, subscribeUiLocale, translatorFor } from "./store.ts";
import {
  __setUiCatalogForTests,
  CONTEXT_SEPARATOR,
  loadUiCatalog,
  placeholderNames,
  translate,
} from "./translate.ts";

describe("uiLocaleForLanguage", () => {
  it.each([
    ["zh", "zh-Hans"],
    ["zh-CN", "zh-Hans"],
    ["en", "en"],
    ["ja", "en"],
    ["pt-BR", "en"],
  ] as const)("reads GT's %s as the fork's %s", (gtLocale, locale) => {
    expect(uiLocaleForLanguage(gtLocale)).toBe(locale);
  });
});

describe("translate", () => {
  it("falls back to the English source and interpolates either way", () => {
    __setUiCatalogForTests("zh-Hans", {
      "Remove {theme}": "移除 {theme}",
      Active: "活跃",
      [`sidebar section${CONTEXT_SEPARATOR}Active`]: "进行中",
    });
    expect(translate("zh-Hans", "Remove {theme}", { theme: "Nord" })).toBe("移除 Nord");
    expect(translate("zh-Hans", "Not translated {name}", { name: "x" })).toBe("Not translated x");
    expect(translate("en", "Remove {theme}", { theme: "Nord" })).toBe("Remove Nord");
    expect(translate("zh-Hans", "Missing {param}", {})).toBe("Missing {param}");
    expect(translate("zh-Hans", "Active", undefined, "sidebar section")).toBe("进行中");
    expect(translate("zh-Hans", "Active", undefined, "unknown context")).toBe("活跃");
    __setUiCatalogForTests("zh-Hans", null);
    expect(translate("zh-Hans", "Remove {theme}", { theme: "Nord" })).toBe("Remove Nord");
  });
});

describe("UI locale store", () => {
  it("publishes a locale only after its catalog loads, and the latest request wins", async () => {
    __setUiCatalogForTests("zh-Hans", null);
    const seen: string[] = [];
    const unsubscribe = subscribeUiLocale(() => seen.push(getUiLocale()));
    const toChinese = setUiLocale("zh-Hans");
    const backToEnglish = setUiLocale("en");
    const backToChinese = setUiLocale("zh-Hans");
    await Promise.all([toChinese, backToEnglish, backToChinese]);
    expect(getUiLocale()).toBe("zh-Hans");
    expect(seen).toEqual(["zh-Hans"]);

    __setUiCatalogForTests("zh-Hans", null);
    await setUiLocale("en");
    seen.length = 0;
    await setUiLocale("zh-Hans");
    expect(seen).toEqual(["zh-Hans"]);
    expect(translatorFor("zh-Hans")("Settings")).toBe("设置");
    expect(translatorFor("zh-Hans")).toBe(translatorFor("zh-Hans"));
    await setUiLocale("en");
    unsubscribe();
  });
});

describe("relative time", () => {
  it("translates whole phrases so the number can move", async () => {
    await loadUiCatalog("zh-Hans");
    expect(formatRelativeElapsedLabel("en", 5 * 60_000)).toBe("5m ago");
    expect(formatRelativeElapsedLabel("zh-Hans", 5 * 60_000)).toBe("5 分钟前");
    expect(formatRelativeElapsedLabel("zh-Hans", 30_000)).toBe("刚刚");
    expect(formatRelativeElapsedLabel("zh-Hans", 3 * 86_400_000)).toBe("3 天前");
    expect(formatCompactElapsedLabel("en", 30_000)).toBe("now");
    expect(formatCompactElapsedLabel("en", 2 * 3_600_000)).toBe("2h");
    expect(formatCompactElapsedLabel("zh-Hans", 2 * 3_600_000)).toBe("2 小时");
  });
});

describe("zh-Hans catalog", () => {
  const entries = Object.values(ZH_HANS_AREAS).flatMap((area) => Object.entries(area));

  it("keeps every translation's placeholders in step with its English source", () => {
    const mismatched = entries.filter(([key, value]) => {
      const source = key.slice(key.indexOf(CONTEXT_SEPARATOR) + 1);
      return placeholderNames(source).join() !== placeholderNames(value).join();
    });
    expect(mismatched).toEqual([]);
  });

  it("uses no em dash, which the copy lint rejects", () => {
    expect(entries.filter(([, value]) => value.includes("—"))).toEqual([]);
  });

  it("translates a key shared by two areas the same way in both", () => {
    const byKey = new Map<string, Set<string>>();
    for (const [key, value] of entries) byKey.set(key, (byKey.get(key) ?? new Set()).add(value));
    expect([...byKey].filter(([, values]) => values.size > 1).map(([key]) => key)).toEqual([]);
  });
});
