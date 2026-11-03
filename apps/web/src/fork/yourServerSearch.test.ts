import { loadUiCatalog, translatorFor, __setUiCatalogForTests } from "@t3tools/client-runtime/i18n";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("~/env"), () => ({ isElectron: true, isSecretsFeatureEnabled: false }));

import { searchSettings } from "../components/settings/settingsSearch";

describe("settings search finds Your server", () => {
  it("by its English title and by the Chinese title the user reads", async () => {
    __setUiCatalogForTests("zh-Hans", await loadUiCatalog("zh-Hans"));
    const zh = translatorFor("zh-Hans");
    expect(searchSettings("your server")[0]?.id).toBe("your-server");
    expect(searchSettings("你的服务器", undefined, zh)[0]?.id).toBe("your-server");
    expect(searchSettings("你的服务器")).toEqual([]);
  });
});
