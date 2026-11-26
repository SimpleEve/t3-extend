import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "../rightPanelStore";
import { shouldRenderPreviewMiniPlayerInSplit } from "./previewMiniPlayerSplit";
import type { PanelLayout } from "./rightPanelSplit";

const browser = (tabId: string): RightPanelSurface => ({
  id: `browser:${tabId}`,
  kind: "preview",
  resourceId: tabId,
});
const file = (name: string): RightPanelSurface => ({
  id: `file:${name}`,
  kind: "file",
  relativePath: name,
  revealLine: null,
  revealRequestId: 1,
});

const layoutOf = (...cells: ReadonlyArray<readonly [string, string]>): PanelLayout => ({
  axis: "row",
  ratio: 0.5,
  groups: [
    { cells: [{ id: "c1", tabIds: [cells[0]![0]], activeId: cells[0]![1] }], ratio: 0.5 },
    { cells: [{ id: "c2", tabIds: [cells[1]![0]], activeId: cells[1]![1] }], ratio: 0.5 },
  ],
  focusedCellId: "c1",
  seq: 2,
  homes: {},
});

describe("the preview mini player in a split panel", () => {
  const source = { kind: "browser", tabId: "t1" } as const;

  it("hides while the playing browser is the selected tab of any visible cell", () => {
    const surfaces = [file("a.ts"), browser("t1")];
    const layout = layoutOf(["file:a.ts", "file:a.ts"], ["browser:t1", "browser:t1"]);
    expect(
      shouldRenderPreviewMiniPlayerInSplit(source, {
        activeSurface: surfaces[0]!,
        surfaces,
        layout,
      }),
    ).toBe(false);
  });

  it("shows when the playing browser is only a background tab", () => {
    const surfaces = [file("a.ts"), file("b.ts"), browser("t1")];
    const layout = layoutOf(["file:a.ts", "file:a.ts"], ["file:b.ts", "file:b.ts"]);
    expect(
      shouldRenderPreviewMiniPlayerInSplit(source, {
        activeSurface: surfaces[0]!,
        surfaces,
        layout,
      }),
    ).toBe(true);
  });

  it("keeps the single-cell rule when the panel is not split", () => {
    const surfaces = [browser("t1")];
    expect(
      shouldRenderPreviewMiniPlayerInSplit(source, {
        activeSurface: surfaces[0]!,
        surfaces,
        layout: null,
      }),
    ).toBe(false);
    expect(
      shouldRenderPreviewMiniPlayerInSplit(source, {
        activeSurface: null,
        surfaces: [],
        layout: null,
      }),
    ).toBe(true);
    expect(
      shouldRenderPreviewMiniPlayerInSplit(null, {
        activeSurface: null,
        surfaces: [],
        layout: null,
      }),
    ).toBe(false);
  });
});
