import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";
import { describe, expect, it } from "vite-plus/test";

import type { PanelLayout } from "./rightPanelSplit";
import { splitTabMenu } from "./rightPanelSplitMenu";

const t = translatorFor("en");
const cell = (id: string, tabs = 2) => ({
  id,
  tabIds: Array.from({ length: tabs }, (_, i) => `${id}-${i}`),
  activeId: `${id}-0`,
});
const layout = (axis: "row" | "column", groups: string[][]): PanelLayout => ({
  axis,
  ratio: 0.5,
  focusedCellId: "c1",
  seq: 4,
  homes: {},
  groups: [
    { cells: groups[0]!.map((id) => cell(id)), ratio: 0.5 },
    { cells: groups[1]!.map((id) => cell(id)), ratio: 0.5 },
  ],
});
const wide = { width: 1200, height: 900 };

describe("splitTabMenu", () => {
  it("offers both splits on an unsplit panel with room and no moves", () => {
    const menu = splitTabMenu({
      t,
      layout: null,
      cellId: "c1",
      tabsInCell: 3,
      cellSize: wide,
      surfaceId: "s",
    });
    expect(menu.items.map((item) => [item.id, item.disabled])).toEqual([
      ["split-right", false],
      ["split-down", false],
    ]);
    expect(menu.operationFor("split-right")).toEqual({
      kind: "split",
      cellId: "c1",
      surfaceId: "s",
      direction: "right",
    });
    expect(menu.operationFor("split-down")).toMatchObject({ direction: "bottom" });
  });

  it("greys the splits out for a lone tab, a narrow panel and a short one", () => {
    const lone = splitTabMenu({
      t,
      layout: null,
      cellId: "c1",
      tabsInCell: 1,
      cellSize: wide,
      surfaceId: "s",
    });
    expect(lone.items.every((item) => item.disabled)).toBe(true);
    expect(lone.operationFor("split-right")).toBeNull();
    const narrow = splitTabMenu({
      t,
      layout: null,
      cellId: "c1",
      tabsInCell: 3,
      cellSize: { width: 540, height: 900 },
      surfaceId: "s",
    });
    expect(narrow.items.map((item) => item.disabled)).toEqual([true, false]);
    const short = splitTabMenu({
      t,
      layout: null,
      cellId: "c1",
      tabsInCell: 3,
      cellSize: { width: 1200, height: 300 },
      surfaceId: "s",
    });
    expect(short.items.map((item) => item.disabled)).toEqual([false, true]);
  });

  it("only offers the cut across the outer one, and nothing once the panel is full", () => {
    const row = splitTabMenu({
      t,
      layout: layout("row", [["c1"], ["c2"]]),
      cellId: "c1",
      tabsInCell: 2,
      cellSize: wide,
      surfaceId: "s",
    });
    expect(row.items.slice(0, 2).map((item) => item.disabled)).toEqual([true, false]);
    const full = splitTabMenu({
      t,
      layout: layout("row", [
        ["c1", "c3"],
        ["c2", "c4"],
      ]),
      cellId: "c1",
      tabsInCell: 2,
      cellSize: wide,
      surfaceId: "s",
    });
    expect(full.items.slice(0, 2).every((item) => item.disabled)).toBe(true);
  });

  it("lists the other cells by where they sit", () => {
    const menu = splitTabMenu({
      t,
      layout: layout("row", [["c1"], ["c2", "c3"]]),
      cellId: "c1",
      tabsInCell: 2,
      cellSize: wide,
      surfaceId: "s",
    });
    expect(menu.items.slice(2).map((item) => [item.id, item.label])).toEqual([
      ["move-to-cell:c2", "Move to the top-right pane"],
      ["move-to-cell:c3", "Move to the bottom-right pane"],
    ]);
    expect(menu.operationFor("move-to-cell:c3")).toEqual({
      kind: "move",
      surfaceId: "s",
      cellId: "c3",
    });
    expect(menu.operationFor("move-to-cell:c1")).toBeNull();
    expect(menu.operationFor("close")).toBeNull();
  });

  it("speaks Chinese in a Chinese interface", async () => {
    await loadUiCatalog("zh-Hans");
    const zh = splitTabMenu({
      t: translatorFor("zh-Hans"),
      layout: layout("row", [["c1"], ["c2"]]),
      cellId: "c1",
      tabsInCell: 2,
      cellSize: wide,
      surfaceId: "s",
    });
    expect(zh.items.map((item) => item.label)).toEqual(["向右拆分", "向下拆分", "移到右格"]);
  });
});
