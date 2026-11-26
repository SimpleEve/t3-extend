import { useDroppable } from "@dnd-kit/core";
import { createContext, useContext, type ComponentProps } from "react";

import { PreviewPanelShell } from "../components/preview/PreviewPanelShell";
import { cn } from "../lib/utils";
import type { SplitTabMenuAction } from "./rightPanelSplitMenu";
import type { ContextMenuItem } from "@t3tools/contracts";

export interface RightPanelCellValue {
  readonly cellId: string;
  /** Whether this cell is the focused one of a split panel; an unsplit panel's one cell is. */
  readonly focused: boolean;
  /** The cell at the window's top right owns the desktop title bar region and its insets. */
  readonly ownsTitleBar: boolean;
  readonly focus: () => void;
  /** Makes the tab bar a place to drop tabs. */
  readonly barRef: (element: HTMLElement | null) => void;
  /** The split entries of a tab's context menu, measured against `anchor`'s cell. */
  readonly tabMenu: (
    surfaceId: string,
    anchor: Element | null,
  ) => {
    readonly items: ContextMenuItem<SplitTabMenuAction>[];
    readonly run: (action: string) => boolean;
  };
}

const RightPanelCellContext = createContext<RightPanelCellValue | null>(null);
export const RightPanelCellProvider = RightPanelCellContext.Provider;

/** Null where the panel is not hosted by the split: PR and issue lists, narrow sheets. */
export function useRightPanelCell(): RightPanelCellValue | null {
  return useContext(RightPanelCellContext);
}

/**
 * What the tab bar and content of a hosted cell sit in instead of the panel shell, which the
 * split host provides once for all cells. The unfocused cells' selected tab is dimmed.
 */
export function RightPanelCellFrame(props: ComponentProps<typeof PreviewPanelShell>) {
  const cell = useRightPanelCell();
  const claimFocus = () => {
    if (cell !== null && !cell.focused) cell.focus();
  };
  return (
    <div
      data-right-panel-cell={cell?.cellId}
      data-cell-focused={cell?.focused ?? true}
      onPointerDownCapture={claimFocus}
      onFocusCapture={claimFocus}
      onMouseDown={props.onMouseDown}
      onMouseUp={props.onMouseUp}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col bg-background",
        "[&[data-cell-focused=false]_[data-active-tab=true]]:bg-accent/45 [&[data-cell-focused=false]_[data-active-tab=true]]:text-muted-foreground",
      )}
    >
      {props.children}
    </div>
  );
}

/** Registers a cell's content area as a drop target; the split host draws the preview. */
export function RightPanelCellDropArea() {
  const cell = useRightPanelCell();
  const { setNodeRef } = useDroppable({
    id: `body:${cell?.cellId ?? ""}`,
    disabled: cell === null,
  });
  if (cell === null) return null;
  return <div ref={setNodeRef} aria-hidden className="pointer-events-none absolute inset-0 z-10" />;
}
