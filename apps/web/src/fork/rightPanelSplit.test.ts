import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "../closedViewStore";
import {
  migratePersistedRightPanelState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  allowedSplitDirections,
  cellsOf,
  focusedCellOf,
  resolveSplitLayout,
  sanitizeLayout,
  type SplitDirection,
} from "./rightPanelSplit";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const other = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

const file = (name: string) => `file:${name}`;

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

const panel = (target = ref) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, target);
const apply = (
  operation: Parameters<ReturnType<typeof useRightPanelStore.getState>["applySplit"]>[1],
) => useRightPanelStore.getState().applySplit(ref, operation);
const cellTabs = () => {
  const layout = panel().layout;
  return layout === undefined ? null : cellsOf(layout).map((cell) => [...cell.tabIds]);
};
const open = (...names: string[]) => {
  for (const name of names) useRightPanelStore.getState().openFile(ref, name);
};
const split = (surface: string, direction: SplitDirection, cellId?: string) =>
  apply({
    kind: "split",
    surfaceId: file(surface),
    direction,
    cellId: cellId ?? focusedCellOf(panel().layout ?? null)?.id ?? "c1",
  });
const cellIdOf = (surface: string) =>
  cellsOf(panel().layout!).find((cell) => cell.tabIds.includes(file(surface)))!.id;

describe("splitting the panel", () => {
  it.each<[SplitDirection, "row" | "column", string[][]]>([
    ["right", "row", [["file:a", "file:b"], ["file:c"]]],
    ["left", "row", [["file:c"], ["file:a", "file:b"]]],
    ["bottom", "column", [["file:a", "file:b"], ["file:c"]]],
    ["top", "column", [["file:c"], ["file:a", "file:b"]]],
  ])("splits a tab out to the %s", (direction, axis, expected) => {
    open("a", "b", "c");
    split("c", direction);
    const layout = panel().layout!;
    expect(layout.axis).toBe(axis);
    expect(cellTabs()).toEqual(expected);
    expect(panel().activeSurfaceId).toBe(file("c"));
    expect(focusedCellOf(layout)?.tabIds).toEqual([file("c")]);
  });

  it("refuses to split out the only tab of a one-cell panel", () => {
    open("a");
    split("a", "right");
    expect(panel().layout).toBeUndefined();
  });

  it("refuses to split the lone tab of a cell away from itself", () => {
    open("a", "b");
    split("b", "right");
    split("b", "bottom", cellIdOf("b"));
    expect(cellTabs()).toEqual([["file:a"], ["file:b"]]);
  });

  it("puts the second cut of a column under the first", () => {
    open("a", "b", "c", "d", "e");
    split("e", "right"); // [a b c d | e]
    split("d", "bottom", cellIdOf("e"));
    expect(cellTabs()).toEqual([["file:a", "file:b", "file:c"], ["file:e"], ["file:d"]]);
  });

  it("allows the perpendicular cut in each half and no other", () => {
    open("a", "b", "c", "d", "e");
    split("e", "right");
    const left = cellIdOf("a");
    const right = cellIdOf("e");
    expect(allowedSplitDirections(panel().layout, left)).toEqual(["top", "bottom"]);
    // A same-direction cut would make three columns.
    split("d", "right", left);
    expect(cellTabs()).toEqual([["file:a", "file:b", "file:c", "file:d"], ["file:e"]]);
    split("d", "bottom", left);
    expect(cellTabs()).toEqual([["file:a", "file:b", "file:c"], ["file:d"], ["file:e"]]);
    expect(allowedSplitDirections(panel().layout, left)).toEqual([]);
    expect(allowedSplitDirections(panel().layout, right)).toEqual(["top", "bottom"]);
    split("c", "top", right);
    expect(cellTabs()?.length).toBe(4);
    const full = cellsOf(panel().layout!);
    expect(full).toHaveLength(4);
    expect(allowedSplitDirections(panel().layout, full[0]!.id)).toEqual([]);
    split("b", "bottom", full[0]!.id);
    expect(cellTabs()?.length).toBe(4);
  });

  it("splits in a column layout left and right", () => {
    open("a", "b", "c");
    split("c", "bottom");
    expect(allowedSplitDirections(panel().layout, cellIdOf("a"))).toEqual(["left", "right"]);
    split("b", "left", cellIdOf("a"));
    expect(cellTabs()).toEqual([["file:b"], ["file:a"], ["file:c"]]);
  });
});

describe("moving tabs between cells", () => {
  it("moves a tab into another cell, selects it and focuses that cell", () => {
    open("a", "b", "c");
    split("c", "right");
    apply({ kind: "move", surfaceId: file("a"), cellId: cellIdOf("c") });
    expect(cellTabs()).toEqual([["file:b"], ["file:c", "file:a"]]);
    expect(panel().activeSurfaceId).toBe(file("a"));
    expect(focusedCellOf(panel().layout!)?.tabIds).toEqual([file("c"), file("a")]);
  });

  it("inserts at a position and reorders inside a cell without changing the selection", () => {
    open("a", "b", "c", "d");
    split("d", "right");
    apply({ kind: "move", surfaceId: file("a"), cellId: cellIdOf("d"), index: 0 });
    expect(cellTabs()).toEqual([
      ["file:b", "file:c"],
      ["file:a", "file:d"],
    ]);
    useRightPanelStore.getState().activateSurface(ref, file("b"));
    apply({ kind: "move", surfaceId: file("b"), cellId: cellIdOf("b"), index: 1 });
    expect(cellTabs()).toEqual([
      ["file:c", "file:b"],
      ["file:a", "file:d"],
    ]);
    expect(panel().activeSurfaceId).toBe(file("b"));
  });

  it("folds the panel back as cells lose their last tab", () => {
    open("a", "b", "c", "d");
    split("d", "right");
    split("c", "bottom", cellIdOf("a"));
    expect(cellTabs()).toEqual([["file:a", "file:b"], ["file:c"], ["file:d"]]);
    useRightPanelStore.getState().closeSurface(ref, file("c"));
    expect(cellTabs()).toEqual([["file:a", "file:b"], ["file:d"]]);
    apply({ kind: "move", surfaceId: file("d"), cellId: cellIdOf("a") });
    expect(panel().layout).toBeUndefined();
    expect(panel().surfaces.map((s) => s.id)).toEqual(["file:a", "file:b", "file:d"]);
    expect(panel().activeSurfaceId).toBe(file("d"));
  });

  it("keeps the other half's cut when a whole half empties", () => {
    open("a", "b", "c", "d");
    split("d", "right"); // [a b c | d]
    split("c", "bottom", cellIdOf("a")); // [a b / c | d]
    split("b", "bottom", cellIdOf("d")); // d alone cannot give b? b moves to new cell under d
    expect(cellsOf(panel().layout!)).toHaveLength(4);
    useRightPanelStore.getState().closeSurface(ref, file("d"));
    useRightPanelStore.getState().closeSurface(ref, file("b"));
    expect(cellTabs()).toEqual([["file:a"], ["file:c"]]);
    expect(panel().layout?.axis).toBe("column");
  });

  it("refuses a drop that would need a third row once the lone tab's cell folds away", () => {
    open("a", "b", "c");
    split("c", "right"); // [a b | c]
    split("b", "bottom", cellIdOf("a")); // [a / b | c]
    expect(cellTabs()).toEqual([["file:a"], ["file:b"], ["file:c"]]);
    split("c", "top", cellIdOf("a"));
    expect(cellTabs()).toEqual([["file:a"], ["file:b"], ["file:c"]]);
  });

  it("moves a lone tab onto another cell's edge when the folded layout has room", () => {
    open("a", "b");
    split("b", "right"); // [a | b]
    split("b", "top", cellIdOf("a"));
    expect(cellTabs()).toEqual([["file:b"], ["file:a"]]);
    expect(panel().layout?.axis).toBe("column");
  });
});

describe("focus and selection", () => {
  it("opens new tabs in the focused cell and focuses where an existing tab is shown", () => {
    open("a", "b", "c");
    split("c", "right");
    useRightPanelStore.getState().applySplit(ref, { kind: "focus", cellId: cellIdOf("a") });
    expect(panel().activeSurfaceId).toBe(focusedCellOf(panel().layout ?? null)!.activeId);
    open("d");
    expect(cellTabs()).toEqual([["file:a", "file:b", "file:d"], ["file:c"]]);
    expect(panel().activeSurfaceId).toBe(file("d"));
    useRightPanelStore.getState().activateSurface(ref, file("c"));
    expect(focusedCellOf(panel().layout!)?.tabIds).toEqual([file("c")]);
    useRightPanelStore.getState().openFile(ref, "a");
    expect(focusedCellOf(panel().layout!)?.tabIds).toEqual([file("a"), file("b"), file("d")]);
  });

  it("falls back to a neighbor in the same cell when the selected tab closes", () => {
    open("a", "b", "c", "d");
    split("d", "right"); // [a b c | d]
    split("c", "bottom", cellIdOf("a")); // [a b / c | d]
    useRightPanelStore.getState().activateSurface(ref, file("b"));
    useRightPanelStore.getState().closeSurface(ref, file("b"));
    expect(panel().activeSurfaceId).toBe(file("a"));
    useRightPanelStore.getState().activateSurface(ref, file("d"));
    useRightPanelStore.getState().closeSurface(ref, file("d"));
    // Its cell is gone; the focus goes to the first cell that is left.
    expect(panel().activeSurfaceId).toBe(file("a"));
    expect(cellTabs()).toEqual([["file:a"], ["file:c"]]);
  });

  it("hands the focus to the cell that took the closed cell's space", () => {
    open("a", "b", "c");
    split("c", "right");
    useRightPanelStore.getState().closeSurface(ref, file("c"));
    expect(panel().layout).toBeUndefined();
    expect(panel().activeSurfaceId).toBe(file("b"));
  });

  it("keeps a swapped surface in its seat", () => {
    open("a", "b", "c");
    useRightPanelStore.getState().open(ref, "files");
    split("c", "right"); // [a b files | c]
    apply({ kind: "focus", cellId: cellIdOf("a") });
    useRightPanelStore.getState().activateSurface(ref, "files");
    useRightPanelStore.getState().navigateFolder(ref, "files", "src", "src");
    expect(cellTabs()).toEqual([["file:a", "file:b", "file:src"], ["file:c"]]);
    expect(panel().activeSurfaceId).toBe(file("src"));
  });
});

describe("closing and reopening", () => {
  it("returns a reopened surface to the cell it was closed in", () => {
    open("a", "b", "c", "d");
    split("d", "right"); // [a b c | d]
    useRightPanelStore.getState().applySplit(ref, { kind: "focus", cellId: cellIdOf("d") });
    useRightPanelStore.getState().closeSurface(ref, file("b"));
    expect(cellTabs()).toEqual([["file:a", "file:c"], ["file:d"]]);
    // Focus is on the right cell, yet b was closed in the left one.
    useRightPanelStore.getState().applySplit(ref, { kind: "focus", cellId: cellIdOf("d") });
    useRightPanelStore.getState().openFile(ref, "b");
    expect(cellTabs()).toEqual([["file:a", "file:c", "file:b"], ["file:d"]]);
  });

  it("opens it in the focused cell when its old cell is gone", () => {
    open("a", "b", "c");
    split("c", "right");
    useRightPanelStore.getState().closeSurface(ref, file("c"));
    expect(panel().layout).toBeUndefined();
    open("d");
    split("d", "right");
    useRightPanelStore.getState().applySplit(ref, { kind: "focus", cellId: cellIdOf("a") });
    useRightPanelStore.getState().openFile(ref, "c");
    expect(focusedCellOf(panel().layout!)?.tabIds).toEqual([file("a"), file("b"), file("c")]);
  });

  it("lets a reopened browser inherit its closed tab's cell", () => {
    open("a", "b", "c");
    useRightPanelStore.getState().openBrowser(ref, "old");
    split("c", "right");
    useRightPanelStore.getState().applySplit(ref, { kind: "focus", cellId: cellIdOf("c") });
    useRightPanelStore.getState().applySplit(ref, { kind: "focus", cellId: cellIdOf("a") });
    useRightPanelStore.getState().closeSurface(ref, "browser:old");
    useRightPanelStore.getState().applySplit(ref, { kind: "focus", cellId: cellIdOf("c") });
    useRightPanelStore
      .getState()
      .applySplit(ref, { kind: "adopt-home", from: "browser:old", to: "browser:new-id" });
    useRightPanelStore.getState().openBrowser(ref, "new-id");
    expect(cellIdOf("a")).toBe(
      cellsOf(panel().layout!).find((cell) => cell.tabIds.includes("browser:new-id"))!.id,
    );
  });
});

describe("persisted layouts", () => {
  it("round-trips the layout through storage", async () => {
    open("a", "b", "c");
    split("c", "bottom");
    apply({ kind: "ratio", target: "outer", ratio: 0.3 });
    const { storage, name } = useRightPanelStore.persist.getOptions();
    const persisted = await storage!.getItem(name!);
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    await storage!.setItem(name!, persisted!);
    await useRightPanelStore.persist.rehydrate();
    expect(cellTabs()).toEqual([["file:a", "file:b"], ["file:c"]]);
    expect(panel().layout?.ratio).toBe(0.3);
  });

  it("reads panels saved before the split existed as one cell", () => {
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        [`env-1:thread-A`]: {
          isOpen: true,
          activeSurfaceId: "diff",
          surfaces: [{ id: "diff", kind: "diff" }],
        },
      },
    });
    const state = Object.values(migrated.byThreadKey)[0]!;
    expect(state.layout).toBeUndefined();
    expect(state.surfaces).toHaveLength(1);
  });

  it.each([
    ["not an object", "oops"],
    ["wrong axis", { axis: "diagonal", ratio: 0.5, groups: [], focusedCellId: "c1", seq: 1 }],
    [
      "one group",
      { axis: "row", ratio: 0.5, groups: [{ cells: [], ratio: 0.5 }], focusedCellId: "c1", seq: 1 },
    ],
    [
      "three cells in a group",
      {
        axis: "row",
        ratio: 0.5,
        focusedCellId: "c1",
        seq: 3,
        groups: [
          {
            ratio: 0.5,
            cells: [
              { id: "c1", tabIds: ["diff"], activeId: "diff" },
              { id: "c2", tabIds: [], activeId: null },
              { id: "c3", tabIds: [], activeId: null },
            ],
          },
          { ratio: 0.5, cells: [{ id: "c4", tabIds: [], activeId: null }] },
        ],
      },
    ],
  ])("drops a bad layout (%s) and shows one cell", (_label, layout) => {
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "diff",
          surfaces: [
            { id: "diff", kind: "diff" },
            { id: "files", kind: "files" },
          ],
          layout,
        },
      },
    });
    const state = Object.values(migrated.byThreadKey)[0]!;
    expect(state.layout).toBeUndefined();
    expect(state.surfaces.map((s) => s.id)).toEqual(["diff", "files"]);
  });

  it("repairs a layout that disagrees with its surfaces", () => {
    const layout = {
      axis: "row",
      ratio: 5,
      focusedCellId: "gone",
      seq: 2,
      homes: { stale: 7 },
      groups: [
        {
          ratio: 0.5,
          cells: [{ id: "c1", tabIds: ["diff", "ghost", "diff"], activeId: "ghost" }],
        },
        { ratio: 0.5, cells: [{ id: "c2", tabIds: ["files"], activeId: "files" }] },
      ],
    };
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "diff",
          surfaces: [
            { id: "diff", kind: "diff" },
            { id: "files", kind: "files" },
            { id: "browser:new", kind: "preview", resourceId: null },
          ],
          layout,
        },
      },
    });
    const state = Object.values(migrated.byThreadKey)[0]!;
    const cells = cellsOf(state.layout!);
    expect(cells.map((cell) => cell.tabIds)).toEqual([["diff", "browser:new"], ["files"]]);
    expect(state.layout!.ratio).toBe(0.9);
    expect(cells.map((cell) => cell.id)).toContain(state.layout!.focusedCellId);
    expect(state.activeSurfaceId).toBe(focusedCellOf(state.layout!)?.activeId);
  });

  it("repairs on read without writing", () => {
    expect(sanitizeLayout(null)).toBeNull();
    expect(resolveSplitLayout({ surfaces: [], activeSurfaceId: null })).toBeNull();
  });
});

describe("the ratio", () => {
  it("clamps the outer and inner ratios and ignores a half that is not split", () => {
    open("a", "b", "c", "d");
    split("d", "right");
    apply({ kind: "ratio", target: "outer", ratio: 0.01 });
    expect(panel().layout?.ratio).toBe(0.1);
    apply({ kind: "ratio", target: 0, ratio: 0.7 });
    expect(panel().layout?.groups[0].ratio).toBe(0.5);
    split("c", "bottom", cellIdOf("a"));
    apply({ kind: "ratio", target: 0, ratio: 0.7 });
    expect(panel().layout?.groups[0].ratio).toBe(0.7);
    expect(panel().layout?.groups[1].ratio).toBe(0.5);
  });
});

describe("panels of other threads", () => {
  it("keeps each thread's layout apart", () => {
    open("a", "b");
    split("b", "right");
    useRightPanelStore.getState().openFile(other, "x");
    expect(panel(other).layout).toBeUndefined();
    expect(panel().layout).toBeDefined();
  });
});

describe("an action that swaps the selected tab for one in another cell", () => {
  const focus = (surface: string) => apply({ kind: "focus", cellId: cellIdOf(surface) });

  it("follows a folder navigation into a file that is already open in the other cell", () => {
    const store = useRightPanelStore.getState();
    open("x.ts", "foo.ts"); // opening a file closes a standalone explorer, so it comes last
    store.open(ref, "files");
    split("foo.ts", "right"); // [x.ts files | foo.ts]
    focus("x.ts");
    store.activateSurface(ref, "files");
    store.navigateFolder(ref, "files", "foo.ts", "foo.ts");
    expect(panel().surfaces.some((s) => s.id === "files")).toBe(false);
    expect(panel().activeSurfaceId).toBe(file("foo.ts"));
    expect(focusedCellOf(panel().layout!)?.tabIds).toEqual([file("foo.ts")]);
  });

  it("follows opening a device that is already open in the other cell", () => {
    const store = useRightPanelStore.getState();
    const target = { hostId: "h", deviceId: "d", platform: "ios" as const, name: "Phone" };
    open("x.ts");
    store.openDevice(ref, target);
    store.open(ref, "device"); // a placeholder beside the real one
    const real = "device:h:d";
    apply({ kind: "split", cellId: "c1", surfaceId: real, direction: "right" });
    apply({ kind: "focus", cellId: "c1" });
    store.activateSurface(ref, "device");
    store.openDevice(ref, target);
    expect(panel().surfaces.some((s) => s.id === "device")).toBe(false);
    expect(panel().activeSurfaceId).toBe(real);
    expect(focusedCellOf(panel().layout!)?.tabIds).toEqual([real]);
  });

  it("still keeps the focus put when closing the selected tab picks a neighbor from another cell", () => {
    open("a", "b", "c");
    split("c", "right"); // [a b | c]
    focus("a");
    useRightPanelStore.getState().closeSurface(ref, file("b"));
    useRightPanelStore.getState().closeSurface(ref, file("a"));
    expect(panel().layout).toBeUndefined();
    expect(panel().activeSurfaceId).toBe(file("c"));
  });
});
