import { shouldRenderPreviewMiniPlayer } from "../components/ChatView.logic";
import type { PreviewMiniPlayerSource } from "../previewMiniPlayerStore";
import type { RightPanelSurface } from "../rightPanelStore";
import { cellsOf, type PanelLayout } from "./rightPanelSplit";

/** The mini player stays hidden while its page or device is the selected tab of any visible cell. */
export function shouldRenderPreviewMiniPlayerInSplit(
  source: PreviewMiniPlayerSource | null,
  panel: {
    readonly activeSurface: RightPanelSurface | null;
    readonly surfaces: readonly RightPanelSurface[];
    readonly layout: PanelLayout | null;
  },
): boolean {
  if (source === null) return false;
  if (panel.layout === null) return shouldRenderPreviewMiniPlayer(source, panel.activeSurface);
  const selected = cellsOf(panel.layout).flatMap((cell) =>
    panel.surfaces.filter((surface) => surface.id === cell.activeId),
  );
  return selected.every((surface) => shouldRenderPreviewMiniPlayer(source, surface));
}
