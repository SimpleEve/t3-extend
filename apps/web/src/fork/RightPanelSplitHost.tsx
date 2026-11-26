import {
  type Active,
  closestCenter,
  DragOverlay,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  pointerWithin,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

import {
  RightPanelTabs,
  type RightPanelTabsProps,
  surfaceTitle,
} from "../components/RightPanelTabs";
import { PreviewPanelShell } from "../components/preview/PreviewPanelShell";
import type { PreviewPanelInlineSize } from "../hooks/usePreviewPanelInlineSize";
import { useT } from "../hooks/useT";
import { observeResize } from "../lib/observeResize";
import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import { TranslatedDndContext as DndContext } from "./TranslatedDndContext";
import { RightPanelSplitDivider, suspendGuestPointerEvents } from "./RightPanelSplitDivider";
import { RightPanelCellProvider, type RightPanelCellValue } from "./rightPanelCell";
import {
  allowedSplitDirections,
  cellsOf,
  type PanelLayout,
  type SplitDirection,
  type SplitOperation,
} from "./rightPanelSplit";
import {
  cellFitsCut,
  dropZoneAt,
  layoutMinSize,
  MIN_CELL_HEIGHT,
  MIN_CELL_WIDTH,
  type DropZone,
  type Rect,
  zoneRect,
} from "./rightPanelSplitGeometry";
import { splitTabMenu } from "./rightPanelSplitMenu";

export interface RightPanelSplitHostProps {
  readonly tabs: Omit<
    RightPanelTabsProps,
    "mode" | "inlineSize" | "maximized" | "layoutControls" | "children"
  >;
  readonly maximized: boolean;
  readonly inlineSize: PreviewPanelInlineSize;
  readonly threadRef: ScopedThreadRef;
  /** Null while the panel is one cell. */
  readonly layout: PanelLayout | null;
  /** What each visible surface shows, by surface id; built once per chat render so cells skip re-rendering. */
  readonly contents: ReadonlyMap<string, ReactNode>;
}

interface HostCell {
  readonly id: string;
  readonly tabIds: readonly string[];
  readonly activeId: string | null;
  readonly box: CSSProperties;
  readonly topLeft: boolean;
  readonly topRight: boolean;
}

const WHOLE: CSSProperties = { inset: 0 };

/** Where a cell sits, from CSS variables on the container so a divider drag moves it without React. */
function cellBox(layout: PanelLayout, g: 0 | 1, c: number): CSSProperties {
  const row = layout.axis === "row";
  const group = layout.groups[g];
  const outer: CSSProperties = row
    ? g === 0
      ? { left: 0, width: "var(--ps-os)" }
      : { left: "var(--ps-os)", right: 0 }
    : g === 0
      ? { top: 0, height: "var(--ps-os)" }
      : { top: "var(--ps-os)", bottom: 0 };
  const inner: CSSProperties =
    group.cells.length === 1
      ? row
        ? { top: 0, bottom: 0 }
        : { left: 0, right: 0 }
      : row
        ? c === 0
          ? { top: 0, height: `var(--ps-i${g})` }
          : { top: `var(--ps-i${g})`, bottom: 0 }
        : c === 0
          ? { left: 0, width: `var(--ps-i${g})` }
          : { left: `var(--ps-i${g})`, right: 0 };
  return { ...outer, ...inner, ...gutter(layout, g, c) };
}

/**
 * Half a divider's width, kept free on each cell's side that touches one. A browser guest draws
 * above the page, so without it the guests would cover the divider and it could not be grabbed.
 */
const GUTTER = 4;

function gutter(layout: PanelLayout, g: 0 | 1, c: number): CSSProperties {
  const row = layout.axis === "row";
  const split = layout.groups[g].cells.length === 2;
  const outer = row
    ? g === 0
      ? "paddingRight"
      : "paddingLeft"
    : g === 0
      ? "paddingBottom"
      : "paddingTop";
  const inner = row
    ? c === 0
      ? "paddingBottom"
      : "paddingTop"
    : c === 0
      ? "paddingRight"
      : "paddingLeft";
  return {
    boxSizing: "border-box",
    [outer]: GUTTER,
    ...(split ? { [inner]: GUTTER } : {}),
  };
}

function containerVariables(layout: PanelLayout): CSSProperties {
  const row = layout.axis === "row";
  const outerMin = row ? MIN_CELL_WIDTH : MIN_CELL_HEIGHT;
  const innerMin = row ? MIN_CELL_HEIGHT : MIN_CELL_WIDTH;
  const clamp = (variable: string, min: number) =>
    `clamp(${min}px, calc(var(${variable}) * 100%), calc(100% - ${min}px))`;
  return {
    "--ps-o": layout.ratio,
    "--ps-g0": layout.groups[0].ratio,
    "--ps-g1": layout.groups[1].ratio,
    "--ps-os": clamp("--ps-o", outerMin),
    "--ps-i0": clamp("--ps-g0", innerMin),
    "--ps-i1": clamp("--ps-g1", innerMin),
  } as CSSProperties;
}

function layoutCells(layout: PanelLayout): HostCell[] {
  const cells: HostCell[] = [];
  const topRightId =
    layout.axis === "row" ? layout.groups[1].cells[0]?.id : layout.groups[0].cells.at(-1)?.id;
  layout.groups.forEach((group, g) => {
    group.cells.forEach((cell, c) => {
      cells.push({
        id: cell.id,
        tabIds: cell.tabIds,
        activeId: cell.activeId,
        box: cellBox(layout, g as 0 | 1, c),
        topLeft: g === 0 && c === 0,
        topRight: cell.id === topRightId,
      });
    });
  });
  return cells;
}

const NO_CONTROLS = <></>;

/** Grabbing a tab from any cell: where it can land is worked out from the cells' rectangles. */
function pointerOf(event: DragMoveEvent | DragEndEvent): { x: number; y: number } | null {
  const origin = event.activatorEvent;
  if (!("clientX" in origin) || typeof origin.clientX !== "number") return null;
  const { clientX, clientY } = origin as MouseEvent;
  return { x: clientX + event.delta.x, y: clientY + event.delta.y };
}

const rectOf = (rect: Rect): Rect => ({
  left: rect.left,
  top: rect.top,
  width: rect.width,
  height: rect.height,
});

interface DropPreview {
  readonly cellId: string;
  readonly zone: DropZone;
  readonly rect: Rect;
}

/**
 * The right panel of a thread: one cell, or up to four. Cells are laid out absolutely on one
 * flat list keyed by cell id, so a cell keeps its mounted content when the arrangement changes.
 */
export function RightPanelSplitHost(props: RightPanelSplitHostProps) {
  const { tabs, layout, threadRef, contents } = props;
  const gt = useGT();
  const t = useT();
  const messages = useMessages();
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [fits, setFits] = useState(true);
  const [drag, setDrag] = useState<{ surfaceId: string; title: string; cellId: string } | null>(
    null,
  );
  const [preview, setPreview] = useState<DropPreview | null>(null);
  const restoreGuests = useRef<(() => void) | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const need = layout === null ? null : layoutMinSize(layout);
  const needWidth = need?.width ?? 0;
  const needHeight = need?.height ?? 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the area's size, which only the DOM knows, to fold a layout that no longer fits
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null || needWidth === 0) return;
    const measure = () => setFits(area.clientWidth >= needWidth && area.clientHeight >= needHeight);
    measure();
    return observeResize(area, measure);
  }, [needWidth, needHeight]);

  const apply = (operation: SplitOperation) =>
    useRightPanelStore.getState().applySplit(threadRef, operation);

  const folded = layout !== null && !fits;
  const surfacesById = new Map<string, RightPanelSurface>(
    tabs.surfaces.map((surface) => [surface.id, surface]),
  );
  const cells: HostCell[] =
    layout === null || folded
      ? [
          {
            id: layout === null ? "c1" : "folded",
            tabIds: tabs.surfaces.map((surface) => surface.id),
            activeId: tabs.activeSurfaceId,
            box: WHOLE,
            topLeft: true,
            topRight: true,
          },
        ]
      : layoutCells(layout);
  const cellOfTab = (surfaceId: string) => cells.find((cell) => cell.tabIds.includes(surfaceId));
  const focusedCellId = layout?.focusedCellId ?? "c1";

  const zonesFor = (cellId: string, rect: Rect, surfaceId: string): SplitDirection[] => {
    if (folded) return [];
    const source = cellOfTab(surfaceId);
    if (source?.id === cellId && source.tabIds.length < 2) return [];
    return allowedSplitDirections(layout ?? undefined, cellId).filter((direction) =>
      cellFitsCut(direction, rect),
    );
  };

  const collisionDetection: CollisionDetection = (args) => {
    if (!args.pointerCoordinates) return closestCenter(args);
    const hits = pointerWithin(args);
    const bar = hits.find((hit) => String(hit.id).startsWith("bar:"));
    if (bar) {
      const cell = cells.find((candidate) => candidate.id === String(bar.id).slice(4));
      const items = args.droppableContainers.filter((container) =>
        cell?.tabIds.includes(String(container.id)),
      );
      const nearest =
        items.length > 0 ? closestCenter({ ...args, droppableContainers: items }) : [];
      return nearest.length > 0 ? nearest : [bar];
    }
    const body = hits.find((hit) => String(hit.id).startsWith("body:"));
    return body ? [body] : [];
  };

  const endDrag = () => {
    restoreGuests.current?.();
    restoreGuests.current = null;
    setDrag(null);
    setPreview(null);
  };

  const onDragStart = (event: DragStartEvent) => {
    const surfaceId = String(event.active.id);
    const title = String(event.active.data.current?.surfaceTitle ?? "");
    setDrag({ surfaceId, title, cellId: cellOfTab(surfaceId)?.id ?? focusedCellId });
    restoreGuests.current = suspendGuestPointerEvents();
  };

  const onDragMove = (event: DragMoveEvent) => {
    const pointer = pointerOf(event);
    const over = event.over;
    if (pointer === null || over === null || !String(over.id).startsWith("body:")) {
      setPreview(null);
      return;
    }
    const cellId = String(over.id).slice("body:".length);
    const rect = rectOf(over.rect);
    const zone = dropZoneAt(rect, pointer, zonesFor(cellId, rect, String(event.active.id)));
    setPreview((current) =>
      current?.cellId === cellId &&
      current.zone === zone &&
      current.rect.left === rect.left &&
      current.rect.top === rect.top &&
      current.rect.width === rect.width &&
      current.rect.height === rect.height
        ? current
        : { cellId, zone, rect },
    );
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    endDrag();
    if (over === null) return;
    const surfaceId = String(active.id);
    const overId = String(over.id);
    const source = cellOfTab(surfaceId);
    if (overId.startsWith("body:")) {
      const cellId = overId.slice("body:".length);
      const pointer = pointerOf(event);
      const rect = rectOf(over.rect);
      const zone =
        pointer === null ? "center" : dropZoneAt(rect, pointer, zonesFor(cellId, rect, surfaceId));
      if (zone !== "center") apply({ kind: "split", cellId, surfaceId, direction: zone });
      else if (source?.id !== cellId && !folded) apply({ kind: "move", surfaceId, cellId });
      return;
    }
    if (overId.startsWith("bar:")) {
      const cellId = overId.slice("bar:".length);
      if (source?.id !== cellId && !folded) apply({ kind: "move", surfaceId, cellId });
      return;
    }
    if (overId === surfaceId) return;
    const target = (layout === null ? cells : cellsOf(layout)).find((cell) =>
      cell.tabIds.includes(overId),
    );
    if (target === undefined) return;
    apply({ kind: "move", surfaceId, cellId: target.id, index: target.tabIds.indexOf(overId) });
  };

  // The defaults would read out droppable ids such as "body:c2".
  const titleOf = (active: Active) => String(active.data.current?.surfaceTitle ?? "");
  const accessibility = {
    announcements: {
      onDragStart: ({ active }) => t("Picked up tab {title}.", { title: titleOf(active) }),
      onDragOver: () => "",
      onDragEnd: ({ active }) => t("Dropped tab {title}.", { title: titleOf(active) }),
      onDragCancel: ({ active }) => t("Cancelled moving tab {title}.", { title: titleOf(active) }),
    },
  } satisfies NonNullable<ComponentProps<typeof DndContext>["accessibility"]>;

  const focusedSurface = tabs.surfaces.find((surface) => surface.id === tabs.activeSurfaceId);
  const workspaceLabel = focusedSurface
    ? gt("Workspace panel: {title}", {
        title: surfaceTitle(
          focusedSurface,
          tabs.previewSessions,
          tabs.terminalLabelsById,
          messages,
        ),
      })
    : gt("Workspace panel");

  const divider = (
    key: string,
    orientation: "vertical" | "horizontal",
    ratioVariable: string,
    ratio: number,
    minSide: number,
    style: CSSProperties,
    target: "outer" | 0 | 1,
  ) => (
    <RightPanelSplitDivider
      key={key}
      orientation={orientation}
      container={() => areaRef.current}
      ratioVariable={ratioVariable}
      ratio={ratio}
      minSide={minSide}
      label={t("Resize panes")}
      style={style}
      onCommit={(next) => apply({ kind: "ratio", target, ratio: next })}
    />
  );

  const dividers: ReactElement[] = [];
  if (layout !== null && !folded) {
    const row = layout.axis === "row";
    dividers.push(
      divider(
        "outer",
        row ? "vertical" : "horizontal",
        "--ps-o",
        layout.ratio,
        row ? MIN_CELL_WIDTH : MIN_CELL_HEIGHT,
        row
          ? { left: "var(--ps-os)", top: 0, bottom: 0 }
          : { top: "var(--ps-os)", left: 0, right: 0 },
        "outer",
      ),
    );
    layout.groups.forEach((group, g) => {
      if (group.cells.length < 2) return;
      const range: CSSProperties = row
        ? g === 0
          ? { left: 0, width: "var(--ps-os)" }
          : { left: "var(--ps-os)", right: 0 }
        : g === 0
          ? { top: 0, height: "var(--ps-os)" }
          : { top: "var(--ps-os)", bottom: 0 };
      dividers.push(
        divider(
          `inner-${g}`,
          row ? "horizontal" : "vertical",
          `--ps-g${g}`,
          group.ratio,
          row ? MIN_CELL_HEIGHT : MIN_CELL_WIDTH,
          { ...range, ...(row ? { top: `var(--ps-i${g})` } : { left: `var(--ps-i${g})` }) },
          g as 0 | 1,
        ),
      );
    });
  }

  return (
    <PreviewPanelShell
      workspaceArea
      workspaceFocusKey={`panel:${tabs.environmentId}:${tabs.activeSurfaceId ?? "empty"}`}
      workspaceLabel={workspaceLabel}
      mode="inline"
      maximized={props.maximized}
      {...(tabs.open !== undefined ? { open: tabs.open } : {})}
      inlineSize={props.inlineSize}
    >
      <DndContext
        accessibility={accessibility}
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        <div
          ref={areaRef}
          data-right-panel-split={layout === null ? "single" : folded ? "folded" : "split"}
          className="relative min-h-0 flex-1"
          style={layout === null ? undefined : containerVariables(layout)}
        >
          {cells.map((cell) => {
            const cellSurfaces = cell.tabIds.flatMap((id) => {
              const surface = surfacesById.get(id);
              return surface === undefined ? [] : [surface];
            });
            return (
              <div key={cell.id} className="absolute min-h-0 min-w-0" style={cell.box}>
                <HostedCell
                  tabs={tabs}
                  cellId={cell.id}
                  focused={layout === null || folded || cell.id === focusedCellId}
                  ownsTitleBar={cell.topRight}
                  insetMaximized={props.maximized && cell.topLeft}
                  hasControls={cell.topRight}
                  surfaces={cellSurfaces}
                  activeId={cell.activeId}
                  content={cell.activeId === null ? null : (contents.get(cell.activeId) ?? null)}
                  layout={folded ? null : layout}
                  onFocus={() => {
                    if (layout !== null && !folded) apply({ kind: "focus", cellId: cell.id });
                  }}
                  onOperation={apply}
                />
              </div>
            );
          })}
          {dividers}
        </div>
        <DragOverlay dropAnimation={null}>
          {drag === null ? null : (
            <div className="flex h-6 max-w-36 items-center rounded-md bg-accent px-2 text-xs text-foreground shadow-md ring-1 ring-border">
              <span className="truncate">{drag.title}</span>
            </div>
          )}
        </DragOverlay>
        {preview !== null &&
        drag !== null &&
        (preview.zone !== "center" || preview.cellId !== drag.cellId)
          ? createPortal(
              <div
                aria-hidden
                data-right-panel-drop-preview={preview.zone}
                className="pointer-events-none fixed rounded-sm bg-primary/10 ring-1 ring-inset ring-primary/40"
                style={{ ...zoneRect(preview.rect, preview.zone), zIndex: 900 }}
              />,
              document.body,
            )
          : null}
      </DndContext>
    </PreviewPanelShell>
  );
}

function HostedCell(props: {
  readonly tabs: RightPanelSplitHostProps["tabs"];
  readonly cellId: string;
  readonly focused: boolean;
  readonly ownsTitleBar: boolean;
  readonly insetMaximized: boolean;
  readonly hasControls: boolean;
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeId: string | null;
  readonly content: ReactNode;
  /** Null for an unsplit or folded panel, where nothing can be cut. */
  readonly layout: PanelLayout | null;
  readonly onFocus: () => void;
  readonly onOperation: (operation: SplitOperation) => void;
}) {
  const { tabs, cellId, surfaces, layout } = props;
  const t = useT();
  const { setNodeRef } = useDroppable({ id: `bar:${cellId}` });
  const value: RightPanelCellValue = {
    cellId,
    focused: props.focused,
    ownsTitleBar: props.ownsTitleBar,
    focus: props.onFocus,
    barRef: setNodeRef,
    tabMenu: (surfaceId, anchor) => {
      const element = anchor?.closest("[data-right-panel-cell]");
      const box = element?.getBoundingClientRect();
      const menu = splitTabMenu({
        t,
        layout,
        cellId,
        tabsInCell: surfaces.length,
        cellSize: box ? { width: box.width, height: box.height } : null,
        surfaceId,
      });
      return {
        items: menu.items,
        run: (action) => {
          const operation = menu.operationFor(action);
          if (operation === null) return false;
          props.onOperation(operation);
          return true;
        },
      };
    },
  };
  return (
    <RightPanelCellProvider value={value}>
      <RightPanelTabs
        {...tabs}
        mode="inline"
        maximized={props.insetMaximized}
        surfaces={surfaces}
        activeSurfaceId={props.activeId}
        {...(props.hasControls ? {} : { layoutControls: NO_CONTROLS })}
        onCloseAllSurfaces={() => tabs.onCloseAllSurfaces(surfaces[0])}
      >
        {props.content}
      </RightPanelTabs>
    </RightPanelCellProvider>
  );
}
