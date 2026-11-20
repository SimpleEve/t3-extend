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
  // fork: T3 Extend saved `uiLanguage` before it adopted upstream's `language`.
  it.effect("moves a saved interface language to the language setting, keeping Chinese", () =>
    Effect.gen(function* () {
      const saved = yield* loadStored({ themeMode: "dark", uiLanguage: "zh-Hans" });
      expect(saved.language).toBe("zh");
      expect(saved.themeMode).toBe("dark");
      expect((yield* loadStored({ uiLanguage: "system" })).language).toBe("system");
      expect((yield* loadStored({ uiLanguage: "fr" })).language).toBeUndefined();
      expect((yield* loadStored({ uiLanguage: "zh-Hans", language: "ja" })).language).toBe("ja");
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
