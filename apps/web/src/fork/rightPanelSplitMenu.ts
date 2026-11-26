import type { ContextMenuItem } from "@t3tools/contracts";
import type { Translator } from "@t3tools/client-runtime/i18n";

import {
  allowedSplitDirections,
  cellsOf,
  type PanelLayout,
  type SplitDirection,
  type SplitOperation,
} from "./rightPanelSplit";
import { cellFitsCut, cellPlaces, type CellPlace, type PanelSize } from "./rightPanelSplitGeometry";

export type SplitTabMenuAction = "split-right" | "split-down" | `move-to-cell:${string}`;

const MOVE_LABELS = (t: Translator): Record<CellPlace, string> => ({
  left: t("Move to the left pane"),
  right: t("Move to the right pane"),
  top: t("Move to the top pane"),
  bottom: t("Move to the bottom pane"),
  "top-left": t("Move to the top-left pane"),
  "top-right": t("Move to the top-right pane"),
  "bottom-left": t("Move to the bottom-left pane"),
  "bottom-right": t("Move to the bottom-right pane"),
});

/** The split entries of a tab's context menu, and the operation each one stands for. */
export function splitTabMenu(input: {
  readonly t: Translator;
  /** Null while the panel is one cell. */
  readonly layout: PanelLayout | null;
  /** Id of the cell holding the tab; the one cell of an unsplit panel is "c1". */
  readonly cellId: string;
  readonly tabsInCell: number;
  /** Size of that cell right now, measured when the menu opens. */
  readonly cellSize: PanelSize | null;
  readonly surfaceId: string;
}): {
  readonly items: ContextMenuItem<SplitTabMenuAction>[];
  readonly operationFor: (action: string) => SplitOperation | null;
} {
  const { t, layout, cellId, surfaceId } = input;
  const allowed = allowedSplitDirections(layout ?? undefined, cellId);
  const canSplit = (direction: SplitDirection) =>
    input.tabsInCell >= 2 &&
    allowed.includes(direction) &&
    (input.cellSize === null || cellFitsCut(direction, input.cellSize));
  const items: ContextMenuItem<SplitTabMenuAction>[] = [
    { id: "split-right", label: t("Split right"), disabled: !canSplit("right") },
    { id: "split-down", label: t("Split down"), disabled: !canSplit("bottom") },
  ];
  const places = layout === null ? null : cellPlaces(layout);
  const labels = MOVE_LABELS(t);
  const targets =
    layout === null || places === null
      ? []
      : cellsOf(layout).filter((cell) => cell.id !== cellId && places.has(cell.id));
  for (const target of targets) {
    const place = places?.get(target.id);
    if (place === undefined) continue;
    items.push({ id: `move-to-cell:${target.id}`, label: labels[place] });
  }
  return {
    items,
    operationFor: (action) => {
      if (action === "split-right" || action === "split-down") {
        const direction = action === "split-right" ? "right" : "bottom";
        return canSplit(direction) ? { kind: "split", cellId, surfaceId, direction } : null;
      }
      if (action.startsWith("move-to-cell:")) {
        const target = action.slice("move-to-cell:".length);
        return targets.some((cell) => cell.id === target)
          ? { kind: "move", surfaceId, cellId: target }
          : null;
      }
      return null;
    },
  };
}
