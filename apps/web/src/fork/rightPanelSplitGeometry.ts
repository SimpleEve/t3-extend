import type { PanelLayout, SplitDirection } from "./rightPanelSplit";

/** Smallest a cell may get; a cut is only offered where both halves keep at least this. */
export const MIN_CELL_WIDTH = 280;
export const MIN_CELL_HEIGHT = 200;

export type DropZone = SplitDirection | "center";

export interface PanelSize {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends PanelSize {
  readonly left: number;
  readonly top: number;
}

/** Whether a cell of this size can be cut in `direction` and leave two cells of at least the minimum. */
export function cellFitsCut(direction: SplitDirection, size: PanelSize): boolean {
  return direction === "left" || direction === "right"
    ? size.width >= 2 * MIN_CELL_WIDTH
    : size.height >= 2 * MIN_CELL_HEIGHT;
}

/** The size the panel needs to draw every cell of the layout at the minimum. */
export function layoutMinSize(layout: PanelLayout): PanelSize {
  const cutAcross = layout.groups.some((group) => group.cells.length > 1);
  const columns = layout.axis === "row" || cutAcross ? 2 : 1;
  const rows = layout.axis === "column" || cutAcross ? 2 : 1;
  return { width: columns * MIN_CELL_WIDTH, height: rows * MIN_CELL_HEIGHT };
}

export function layoutFits(layout: PanelLayout, size: PanelSize): boolean {
  const need = layoutMinSize(layout);
  return size.width >= need.width && size.height >= need.height;
}

const BAND_FRACTION = 0.25;
const BAND_MIN = 40;
const BAND_MAX = 120;

const bandOf = (length: number) => Math.min(BAND_MAX, Math.max(BAND_MIN, length * BAND_FRACTION));

const isHorizontal = (direction: SplitDirection) => direction === "left" || direction === "right";

/**
 * Where in a cell a dragged tab would land: a band along each allowed edge cuts the cell that
 * way, anywhere else moves the tab into the cell. In a corner the nearer edge wins.
 */
export function dropZoneAt(
  rect: Rect,
  point: { readonly x: number; readonly y: number },
  allowed: readonly SplitDirection[],
): DropZone {
  const distances: Record<SplitDirection, number> = {
    left: point.x - rect.left,
    right: rect.left + rect.width - point.x,
    top: point.y - rect.top,
    bottom: rect.top + rect.height - point.y,
  };
  const bandX = bandOf(rect.width);
  const bandY = bandOf(rect.height);
  const depth = (direction: SplitDirection) =>
    distances[direction] / (isHorizontal(direction) ? bandX : bandY);
  let best: SplitDirection | null = null;
  for (const direction of allowed) {
    const distance = distances[direction];
    if (distance < 0 || depth(direction) > 1) continue;
    if (best === null || depth(direction) < depth(best)) best = direction;
  }
  return best ?? "center";
}

/** The part of a cell a drop would take over, for the preview. */
export function zoneRect(rect: Rect, zone: DropZone): Rect {
  switch (zone) {
    case "left":
      return { ...rect, width: rect.width / 2 };
    case "right":
      return { ...rect, left: rect.left + rect.width / 2, width: rect.width / 2 };
    case "top":
      return { ...rect, height: rect.height / 2 };
    case "bottom":
      return { ...rect, top: rect.top + rect.height / 2, height: rect.height / 2 };
    case "center":
      return rect;
  }
}

export type CellPlace =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** Where each cell sits in the panel, so a tab menu can say "the pane on the right". */
export function cellPlaces(layout: PanelLayout): ReadonlyMap<string, CellPlace> {
  const places = new Map<string, CellPlace>();
  layout.groups.forEach((group, g) => {
    const outer = layout.axis === "row" ? (g === 0 ? "left" : "right") : g === 0 ? "top" : "bottom";
    group.cells.forEach((cell, c) => {
      if (group.cells.length === 1) {
        places.set(cell.id, outer);
        return;
      }
      const inner =
        layout.axis === "row" ? (c === 0 ? "top" : "bottom") : c === 0 ? "left" : "right";
      places.set(
        cell.id,
        (layout.axis === "row" ? `${inner}-${outer}` : `${outer}-${inner}`) as CellPlace,
      );
    });
  });
  return places;
}
