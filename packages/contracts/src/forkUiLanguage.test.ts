import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { migrateLegacyUiLanguage } from "./forkUiLanguage.ts";
import { ClientSettingsSchema } from "./settings.ts";

const decode = (raw: unknown) =>
  Schema.decodeUnknownSync(ClientSettingsSchema)(migrateLegacyUiLanguage(raw));

describe("legacy interface language", () => {
  it("keeps a user's saved Chinese and maps the other saved values", () => {
    expect(decode({ uiLanguage: "zh-Hans" }).language).toBe("zh");
    expect(decode({ uiLanguage: "en" }).language).toBe("en");
    expect(decode({ uiLanguage: "system" }).language).toBe("system");
    expect(decode({}).language).toBe("system");
  });

  it("lets a saved language win and drops the legacy key", () => {
    const migrated = migrateLegacyUiLanguage({ uiLanguage: "zh-Hans", language: "ja" });
    expect(migrated).toEqual({ language: "ja" });
    expect(migrateLegacyUiLanguage({ uiLanguage: "klingon" })).toEqual({});
    expect(migrateLegacyUiLanguage(null)).toBeNull();
  });
});
