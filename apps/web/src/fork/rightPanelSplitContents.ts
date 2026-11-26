import { cloneElement, type ReactElement, type ReactNode } from "react";

import type { RightPanelSurface } from "../rightPanelStore";
import { cellsOf, type PanelLayout } from "./rightPanelSplit";

type SurfaceContent = ReactElement<{
  surface: RightPanelSurface | null;
  activeSurfaceId: string | null;
  focused?: boolean;
}>;

/**
 * What each visible surface shows, by surface id. A split panel shows one surface per cell; the
 * other cells are the focused cell's element with their own surface and no keyboard focus.
 */
export function splitContents(
  focusedContent: SurfaceContent | null,
  layout: PanelLayout | null,
  surfaces: readonly RightPanelSurface[],
  focusedSurface: RightPanelSurface | null,
): ReadonlyMap<string, ReactNode> {
  const contents = new Map<string, ReactNode>();
  if (focusedContent === null) return contents;
  if (focusedSurface !== null) contents.set(focusedSurface.id, focusedContent);
  if (layout === null) return contents;
  for (const cell of cellsOf(layout)) {
    const surface = surfaces.find((entry) => entry.id === cell.activeId);
    if (surface === undefined || contents.has(surface.id)) continue;
    contents.set(
      surface.id,
      cloneElement(focusedContent, { surface, activeSurfaceId: surface.id, focused: false }),
    );
  }
  return contents;
}
