import { describe, expect, it } from "vite-plus/test";

import type { PanelLayout } from "./rightPanelSplit";
import {
  cellFitsCut,
  cellPlaces,
  dropZoneAt,
  layoutFits,
  layoutMinSize,
  MIN_CELL_HEIGHT,
  MIN_CELL_WIDTH,
} from "./rightPanelSplitGeometry";

const cell = (id: string) => ({ id, tabIds: [id], activeId: id });
const layout = (axis: "row" | "column", groups: string[][]): PanelLayout => ({
  axis,
  ratio: 0.5,
  focusedCellId: "c1",
  seq: 4,
  homes: {},
  groups: [
    { cells: groups[0]!.map(cell), ratio: 0.5 },
    { cells: groups[1]!.map(cell), ratio: 0.5 },
  ],
});

const rect = { left: 100, top: 50, width: 400, height: 500 };
const all = ["left", "right", "top", "bottom"] as const;

describe("dropZoneAt", () => {
  it("cuts along the edge the pointer is near and moves in elsewhere", () => {
    expect(dropZoneAt(rect, { x: 110, y: 300 }, all)).toBe("left");
    expect(dropZoneAt(rect, { x: 490, y: 300 }, all)).toBe("right");
    expect(dropZoneAt(rect, { x: 300, y: 60 }, all)).toBe("top");
    expect(dropZoneAt(rect, { x: 300, y: 540 }, all)).toBe("bottom");
    expect(dropZoneAt(rect, { x: 300, y: 300 }, all)).toBe("center");
  });

  it("prefers the nearer edge in a corner", () => {
    expect(dropZoneAt(rect, { x: 105, y: 150 }, all)).toBe("left");
    expect(dropZoneAt(rect, { x: 180, y: 52 }, all)).toBe("top");
  });

  it("offers only allowed edges, otherwise moves in", () => {
    expect(dropZoneAt(rect, { x: 105, y: 300 }, ["top", "bottom"])).toBe("center");
    expect(dropZoneAt(rect, { x: 105, y: 300 }, [])).toBe("center");
  });

  it("keeps a usable band in a small cell and a capped one in a large cell", () => {
    const small = { left: 0, top: 0, width: 100, height: 100 };
    expect(dropZoneAt(small, { x: 38, y: 50 }, all)).toBe("left");
    expect(dropZoneAt(small, { x: 50, y: 50 }, all)).toBe("center");
    const large = { left: 0, top: 0, width: 2000, height: 2000 };
    expect(dropZoneAt(large, { x: 119, y: 1000 }, all)).toBe("left");
    expect(dropZoneAt(large, { x: 121, y: 1000 }, all)).toBe("center");
  });
});

describe("sizes", () => {
  it("offers a left or right cut only to a cell wide enough for two", () => {
    expect(cellFitsCut("right", { width: 2 * MIN_CELL_WIDTH - 1, height: 900 })).toBe(false);
    expect(cellFitsCut("left", { width: 2 * MIN_CELL_WIDTH, height: 10 })).toBe(true);
    expect(cellFitsCut("bottom", { width: 100, height: 2 * MIN_CELL_HEIGHT - 1 })).toBe(false);
    expect(cellFitsCut("top", { width: 100, height: 2 * MIN_CELL_HEIGHT })).toBe(true);
  });

  it("the default 540 px panel is too narrow for a left-right cut", () => {
    expect(cellFitsCut("right", { width: 540, height: 800 })).toBe(false);
  });

  it("works out what a layout needs", () => {
    expect(layoutMinSize(layout("row", [["c1"], ["c2"]]))).toEqual({
      width: 2 * MIN_CELL_WIDTH,
      height: MIN_CELL_HEIGHT,
    });
    expect(layoutMinSize(layout("column", [["c1"], ["c2"]]))).toEqual({
      width: MIN_CELL_WIDTH,
      height: 2 * MIN_CELL_HEIGHT,
    });
    expect(layoutMinSize(layout("row", [["c1", "c2"], ["c3"]]))).toEqual({
      width: 2 * MIN_CELL_WIDTH,
      height: 2 * MIN_CELL_HEIGHT,
    });
    expect(layoutMinSize(layout("column", [["c1", "c2"], ["c3"]]))).toEqual({
      width: 2 * MIN_CELL_WIDTH,
      height: 2 * MIN_CELL_HEIGHT,
    });
    expect(layoutFits(layout("row", [["c1"], ["c2"]]), { width: 540, height: 800 })).toBe(false);
    expect(layoutFits(layout("row", [["c1"], ["c2"]]), { width: 700, height: 800 })).toBe(true);
  });

  it("names where each cell sits", () => {
    expect([...cellPlaces(layout("row", [["c1"], ["c2"]]))]).toEqual([
      ["c1", "left"],
      ["c2", "right"],
    ]);
    expect([...cellPlaces(layout("column", [["c1"], ["c2"]]))]).toEqual([
      ["c1", "top"],
      ["c2", "bottom"],
    ]);
    expect([...cellPlaces(layout("row", [["c1"], ["c2", "c3"]]))]).toEqual([
      ["c1", "left"],
      ["c2", "top-right"],
      ["c3", "bottom-right"],
    ]);
    expect([
      ...cellPlaces(
        layout("column", [
          ["c1", "c2"],
          ["c3", "c4"],
        ]),
      ),
    ]).toEqual([
      ["c1", "top-left"],
      ["c2", "top-right"],
      ["c3", "bottom-left"],
      ["c4", "bottom-right"],
    ]);
  });
});
