import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Preferences } from "../persistence/mobile-preferences";
import { MAX_COLLAPSED_GROUPS, toggleCollapsedKey } from "./threadListCollapse";
import {
  resolveThreadListViewState,
  useThreadListViewState,
  VIEW_PREFERENCE_GRACE_MS,
} from "./threadListViewState";

const stored = (preferences: Preferences) => AsyncResult.success(preferences);

describe("resolveThreadListViewState", () => {
  it("draws nothing while the preference is pending, until the grace runs out", () => {
    expect(resolveThreadListViewState(AsyncResult.initial(true), false)).toMatchObject({
      ready: false,
      writable: false,
      viewMode: "status",
    });
    expect(resolveThreadListViewState(AsyncResult.initial(true), true)).toMatchObject({
      ready: true,
      writable: false,
      viewMode: "status",
      failure: null,
    });
  });

  it("falls back to the status view at once when the read fails, and says why", () => {
    const state = resolveThreadListViewState(
      AsyncResult.fail(new Error("disk"), { waiting: false }),
      false,
    );
    expect(state).toMatchObject({ ready: true, writable: false, viewMode: "status" });
    expect(state.failure?.cause).toBeDefined();
  });

  it("uses the stored view and folds once they arrive", () => {
    expect(
      resolveThreadListViewState(
        stored({ threadListViewMode: "project", threadListCollapsedGroups: ["k"] }),
        false,
      ),
    ).toMatchObject({ ready: true, writable: true, viewMode: "project", collapsed: ["k"] });
  });

  it("groups by project on a device that never chose, and keeps a chosen status view", () => {
    expect(resolveThreadListViewState(stored({}), false)).toMatchObject({
      ready: true,
      writable: true,
      viewMode: "project",
    });
    expect(
      resolveThreadListViewState(stored({ threadListViewMode: "status" }), false),
    ).toMatchObject({ writable: true, viewMode: "status" });
  });
});

describe("toggleCollapsedKey", () => {
  it("toggles a key and keeps only the newest folds, so deleted projects age out", () => {
    expect(toggleCollapsedKey(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleCollapsedKey(["a", "b"], "a")).toEqual(["b"]);
    const full = Array.from({ length: MAX_COLLAPSED_GROUPS }, (_, index) => `k${index}`);
    const next = toggleCollapsedKey(full, "new");
    expect(next).toHaveLength(MAX_COLLAPSED_GROUPS);
    expect(next[0]).toBe("k1");
    expect(next.at(-1)).toBe("new");
  });
});

it("keeps what the user chose while the saved view was late, and saves it over the saved view", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  type Result = AsyncResult.AsyncResult<Preferences, unknown>;
  const saved: Array<(current: Preferences) => Partial<Preferences>> = [];
  const save = (update: unknown) => {
    if (typeof update === "object" && update !== null && "transform" in update) {
      saved.push(update.transform as (typeof saved)[number]);
    }
  };
  let api: ReturnType<typeof useThreadListViewState> | undefined;
  function Probe(props: { readonly result: Result }) {
    const state = useThreadListViewState(props.result, save);
    useLayoutEffect(() => {
      api = state;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe result={AsyncResult.initial(true)} />));
  expect(api?.ready).toBe(false);

  // Past the grace, the status view shows; the user switches views and folds a group.
  await act(async () => vi.advanceTimersByTime(VIEW_PREFERENCE_GRACE_MS));
  expect(api).toMatchObject({ ready: true, viewMode: "status" });
  await act(async () => {
    api?.setViewMode("project");
    api?.toggleGroup("project:project:repo");
  });
  expect(api).toMatchObject({ viewMode: "project", collapsed: ["project:project:repo"] });
  expect(saved).toHaveLength(0);

  // The saved view arrives and disagrees; the choices win, once, on top of what was saved.
  const stored = {
    threadListViewMode: "status",
    threadListCollapsedGroups: ["old", "project:project:repo"],
  } as const;
  await act(async () => root.render(<Probe result={AsyncResult.success(stored)} />));
  expect(saved).toHaveLength(1);
  expect(saved[0]?.(stored)).toEqual({
    threadListViewMode: "project",
    threadListCollapsedGroups: ["old", "project:project:repo"],
  });

  // The saved value now carries the choices, so nothing is saved again.
  const merged = { ...stored, ...saved[0]?.(stored) };
  await act(async () => root.render(<Probe result={AsyncResult.success(merged)} />));
  expect(api).toMatchObject({ viewMode: "project" });
  expect(saved).toHaveLength(1);
  act(() => root.unmount());
});
