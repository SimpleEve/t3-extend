import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

function loadStored(payload: object) {
  const unused = Effect.die("unused in this test");
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: () => unused,
    listCache: () => unused,
    saveCache: () => unused,
    removeCache: () => unused,
    clearCacheKind: () => unused,
    clearEnvironmentCache: () => unused,
    clearAllCaches: unused,
    inspectCaches: unused,
    loadPreferencesJson: Effect.succeedSome({ payload: JSON.stringify(payload), updatedAt: 1 }),
    savePreferencesJson: () => Effect.void,
  });
  const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  return MobilePreferences.MobilePreferencesStore.pipe(
    Effect.flatMap((store) => store.load),
    Effect.provide(
      MobilePreferences.layer.pipe(
        Layer.provide(Layer.succeed(MobileDatabase.MobileDatabase, database)),
        Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, secureStorage)),
      ),
    ),
  );
}

describe("mobile preferences store", () => {
  it.effect("reads the interface language, defaulting to system for old or unknown values", () =>
    Effect.gen(function* () {
      const saved = yield* loadStored({ themeMode: "dark", uiLanguage: "zh-Hans" });
      expect(MobilePreferences.uiLanguageSettingOf(saved)).toBe("zh-Hans");

      const old = yield* loadStored({ themeMode: "dark" });
      expect(old.uiLanguage).toBeUndefined();
      expect(MobilePreferences.uiLanguageSettingOf(old)).toBe("system");
      expect(old.themeMode).toBe("dark");

      const unknown = yield* loadStored({ uiLanguage: "fr" });
      expect(unknown.uiLanguage).toBeUndefined();
      expect(MobilePreferences.uiLanguageSettingOf(unknown)).toBe("system");

      expect(MobilePreferences.uiLanguageSettingOf(null)).toBe("system");
    }),
  );

  it.effect("reads the thread list view and its folds, ignoring bad values", () =>
    Effect.gen(function* () {
      const saved = yield* loadStored({
        threadListViewMode: "project",
        threadListCollapsedGroups: ["project:project:repo", 3, "project:worktree:a"],
      });
      expect(saved.threadListViewMode).toBe("project");
      expect(saved.threadListCollapsedGroups).toEqual([
        "project:project:repo",
        "project:worktree:a",
      ]);

      // Longer than the cap keeps the newest folds, like toggling does.
      const long = Array.from({ length: 205 }, (_, index) => `k${index}`);
      const trimmed = yield* loadStored({ threadListCollapsedGroups: long });
      expect(trimmed.threadListCollapsedGroups).toEqual(long.slice(-200));

      const bad = yield* loadStored({ threadListViewMode: "grid", threadListCollapsedGroups: "x" });
      expect(bad.threadListViewMode).toBeUndefined();
      expect(bad.threadListCollapsedGroups).toBeUndefined();
    }),
  );
});
