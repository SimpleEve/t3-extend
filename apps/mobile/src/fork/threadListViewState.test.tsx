import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Preferences } from "../persistence/mobile-preferences";
import {
  MAX_COLLAPSED_GROUPS,
  resolveThreadListViewState,
  toggleCollapsedKey,
  useThreadListViewState,
  VIEW_PREFERENCE_GRACE_MS,
  type ThreadListViewState,
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

it("shows the status view once the grace runs out on a preference that never arrives, then the stored view", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  const seen: ThreadListViewState[] = [];
  function Probe(props: { readonly result: AsyncResult.AsyncResult<Preferences, unknown> }) {
    const state = useThreadListViewState(props.result);
    useLayoutEffect(() => {
      seen.push(state);
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe result={AsyncResult.initial(true)} />));
  expect(seen.at(-1)?.ready).toBe(false);

  await act(async () => vi.advanceTimersByTime(VIEW_PREFERENCE_GRACE_MS));
  expect(seen.at(-1)).toMatchObject({ ready: true, writable: false, viewMode: "status" });

  await act(async () => root.render(<Probe result={stored({ threadListViewMode: "project" })} />));
  expect(seen.at(-1)).toMatchObject({ ready: true, writable: true, viewMode: "project" });
  act(() => root.unmount());
});
