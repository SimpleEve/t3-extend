import type { ThreadRightPanelState } from "../rightPanelStore";

/**
 * Up to four cells (2×2): one outer cut, and each half is a cell or is cut once more across it.
 * Flat `surfaces` and `activeSurfaceId` stay the truth; the layout only places surfaces in cells,
 * and `reconcileSplit` repairs it after every update.
 */

export type SplitDirection = "left" | "right" | "top" | "bottom";
export type SplitAxis = "row" | "column";

export interface PanelCell {
  readonly id: string;
  readonly tabIds: readonly string[];
  readonly activeId: string | null;
}

export interface PanelGroup {
  readonly cells: readonly PanelCell[];
  /** Share of the first cell when the group holds two. */
  readonly ratio: number;
}

export interface PanelLayout {
  /** `row`: groups sit side by side. `column`: groups are stacked. */
  readonly axis: SplitAxis;
  /** Share of the first group. */
  readonly ratio: number;
  readonly groups: readonly [PanelGroup, PanelGroup];
  readonly focusedCellId: string;
  /** Last number used in a cell id, so ids are never reused. */
  readonly seq: number;
  /** Where closed surfaces last sat, so reopening them returns there. */
  readonly homes: Readonly<Record<string, string>>;
}

const MAX_SPLIT_CELLS = 4;
const MAX_HOMES = 24;
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

type SplitState = Pick<ThreadRightPanelState, "surfaces" | "activeSurfaceId" | "layout">;

const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : 0.5;

export const cellsOf = (layout: PanelLayout): PanelCell[] => layout.groups.flatMap((g) => g.cells);

const findCell = (layout: PanelLayout, cellId: string): PanelCell | null =>
  cellsOf(layout).find((cell) => cell.id === cellId) ?? null;

const cellOfSurface = (layout: PanelLayout, surfaceId: string): PanelCell | null =>
  cellsOf(layout).find((cell) => cell.tabIds.includes(surfaceId)) ?? null;

const cellId = (n: number) => `c${n}`;

const axisOf = (direction: SplitDirection): SplitAxis =>
  direction === "left" || direction === "right" ? "row" : "column";

const entersFirst = (direction: SplitDirection) => direction === "left" || direction === "top";

/** The cell's selected tab; a cell never stays without one while it has tabs. */
const settledCell = (cell: PanelCell): PanelCell => {
  const activeId =
    cell.activeId !== null && cell.tabIds.includes(cell.activeId)
      ? cell.activeId
      : (cell.tabIds[0] ?? null);
  return activeId === cell.activeId ? cell : { ...cell, activeId };
};

/** The tab that takes over when the cell's selected tab leaves, as the single strip does. */
function neighborAfterRemoval(
  before: readonly string[],
  removedId: string | null,
  remaining: readonly string[],
): string | null {
  if (remaining.length === 0) return null;
  const index = removedId === null ? 0 : Math.max(0, before.indexOf(removedId));
  return remaining[Math.min(index, remaining.length - 1)] ?? null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function sanitizeCell(raw: unknown, seen: Set<string>, cellIds: Set<string>): PanelCell | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "" || cellIds.has(raw.id)) {
    return null;
  }
  if (!Array.isArray(raw.tabIds)) return null;
  const tabIds = raw.tabIds.filter((id): id is string => {
    if (typeof id !== "string" || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  cellIds.add(raw.id);
  return settledCell({
    id: raw.id,
    tabIds,
    activeId: typeof raw.activeId === "string" ? raw.activeId : null,
  });
}

/**
 * A layout with its structure checked and its numbers made safe, or null when it is not a
 * layout this build can draw. Which surfaces exist is `reconcileSplit`'s concern.
 */
export function sanitizeLayout(raw: unknown): PanelLayout | null {
  if (!isRecord(raw)) return null;
  if (raw.axis !== "row" && raw.axis !== "column") return null;
  if (!Array.isArray(raw.groups) || raw.groups.length !== 2) return null;
  const seen = new Set<string>();
  const cellIds = new Set<string>();
  const groups: PanelGroup[] = [];
  for (const rawGroup of raw.groups) {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.cells)) return null;
    if (rawGroup.cells.length < 1 || rawGroup.cells.length > 2) return null;
    const cells: PanelCell[] = [];
    for (const rawCell of rawGroup.cells) {
      const cell = sanitizeCell(rawCell, seen, cellIds);
      if (cell === null) return null;
      cells.push(cell);
    }
    groups.push({
      cells,
      ratio: clampRatio(typeof rawGroup.ratio === "number" ? rawGroup.ratio : 0.5),
    });
  }
  const [first, second] = groups;
  if (first === undefined || second === undefined) return null;
  const all = [...first.cells, ...second.cells];
  const highest = Math.max(
    0,
    ...all.map((cell) => Number(/^c(\d+)$/.exec(cell.id)?.[1] ?? 0)),
    typeof raw.seq === "number" && Number.isSafeInteger(raw.seq) ? raw.seq : 0,
  );
  const homes = isRecord(raw.homes)
    ? Object.fromEntries(
        Object.entries(raw.homes).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
  return {
    axis: raw.axis,
    ratio: clampRatio(typeof raw.ratio === "number" ? raw.ratio : 0.5),
    groups: [first, second],
    focusedCellId: all.some((cell) => cell.id === raw.focusedCellId)
      ? (raw.focusedCellId as string)
      : (all[0]?.id ?? ""),
    seq: highest,
    homes,
  };
}

function mapCells(layout: PanelLayout, update: (cell: PanelCell) => PanelCell): PanelLayout {
  let changed = false;
  const groups = layout.groups.map((group) => {
    const cells = group.cells.map((cell) => {
      const next = update(cell);
      if (next !== cell) changed = true;
      return next;
    });
    return cells.some((cell, i) => cell !== group.cells[i]) ? { ...group, cells } : group;
  });
  const [first, second] = groups;
  return changed && first !== undefined && second !== undefined
    ? { ...layout, groups: [first, second] }
    : layout;
}

/** One cell alone is the unsplit panel, which has no layout. */
type Shape = { readonly layout: PanelLayout } | { readonly sole: PanelCell };

/** Drops cells without tabs and folds the layout back as far as that leaves room to. */
function collapse(layout: PanelLayout): Shape | null {
  const groups = layout.groups
    .map((group) => ({ ...group, cells: group.cells.filter((cell) => cell.tabIds.length > 0) }))
    .filter((group) => group.cells.length > 0);
  const [first, second] = groups;
  if (first === undefined) return null;
  if (second !== undefined) return { layout: { ...layout, groups: [first, second] } };
  const [one, two] = first.cells;
  if (one === undefined) return null;
  if (two === undefined) return { sole: one };
  return {
    layout: {
      ...layout,
      axis: layout.axis === "row" ? "column" : "row",
      ratio: first.ratio,
      groups: [
        { cells: [one], ratio: 0.5 },
        { cells: [two], ratio: 0.5 },
      ],
    },
  };
}

function sameCell(a: PanelCell, b: PanelCell): boolean {
  return (
    a.id === b.id &&
    a.activeId === b.activeId &&
    a.tabIds.length === b.tabIds.length &&
    a.tabIds.every((id, i) => id === b.tabIds[i])
  );
}

function sameLayout(a: PanelLayout, b: PanelLayout): boolean {
  if (
    a.axis !== b.axis ||
    a.ratio !== b.ratio ||
    a.focusedCellId !== b.focusedCellId ||
    a.seq !== b.seq
  ) {
    return false;
  }
  const homesA = Object.entries(a.homes);
  if (homesA.length !== Object.keys(b.homes).length) return false;
  if (homesA.some(([id, home]) => b.homes[id] !== home)) return false;
  return a.groups.every((group, g) => {
    const other = b.groups[g];
    return (
      other !== undefined &&
      group.ratio === other.ratio &&
      group.cells.length === other.cells.length &&
      group.cells.every((cell, i) => {
        const counterpart = other.cells[i];
        return counterpart !== undefined && sameCell(cell, counterpart);
      })
    );
  });
}

function trimHomes(homes: Record<string, string>): Record<string, string> {
  const entries = Object.entries(homes);
  return entries.length <= MAX_HOMES ? homes : Object.fromEntries(entries.slice(-MAX_HOMES));
}

/** The cell that takes over the focus of a cell that went away: its neighbor, else any cell. */
function heirOf(before: PanelLayout, goneId: string, survivors: readonly PanelCell[]): string {
  const group = before.groups.find((candidate) => candidate.cells.some((c) => c.id === goneId));
  const neighbor = group?.cells.find(
    (cell) => cell.id !== goneId && survivors.some((s) => s.id === cell.id),
  );
  if (neighbor !== undefined) return neighbor.id;
  const otherGroup = before.groups.find((candidate) => candidate !== group);
  const inOther = otherGroup?.cells.find((cell) => survivors.some((s) => s.id === cell.id));
  return inOther?.id ?? survivors[0]?.id ?? goneId;
}

function stripLayout<T extends SplitState>(state: T): T {
  if (state.layout === undefined) return state;
  const { layout: _dropped, ...rest } = state;
  return rest as T;
}

function flatten<T extends SplitState>(
  state: T,
  order: readonly string[],
  activeSurfaceId: string | null,
  layout: PanelLayout | undefined,
): T {
  const byId = new Map<string, T["surfaces"][number]>(
    state.surfaces.map((surface) => [surface.id, surface]),
  );
  const ordered = order.flatMap((id) => {
    const surface = byId.get(id);
    return surface === undefined ? [] : [surface];
  });
  const sameOrder =
    ordered.length === state.surfaces.length && ordered.every((s, i) => s === state.surfaces[i]);
  const surfaces = sameOrder ? state.surfaces : ordered;
  if (
    surfaces === state.surfaces &&
    activeSurfaceId === state.activeSurfaceId &&
    layout === state.layout
  ) {
    return state;
  }
  const base = stripLayout(state);
  return {
    ...base,
    surfaces,
    activeSurfaceId,
    ...(layout === undefined ? {} : { layout }),
  } as T;
}

/**
 * Makes a state's layout agree with its flat surfaces after any update: surfaces that vanished
 * leave their cell, new ones land in a cell, empty cells fold away, and the flat active surface
 * follows the focused cell. Idempotent, and returns `next` itself when nothing needs repair.
 */
export function reconcileSplit<T extends SplitState>(
  prev: T,
  next: T,
  /** The update is a user action that does not close a view. */
  userAction = false,
): T {
  if (prev.layout === undefined && next.layout === undefined) return next;
  const checked = next.layout === undefined ? null : sanitizeLayout(next.layout);
  if (checked === null) return stripLayout(next);

  const surfaceIds = new Set<string>(next.surfaces.map((surface) => surface.id));
  const removed = new Map<string, { cellId: string; index: number; wasActive: boolean }>();
  let layout = mapCells(checked, (cell) => {
    const kept = cell.tabIds.filter((id) => surfaceIds.has(id));
    if (kept.length === cell.tabIds.length) return settledCell(cell);
    cell.tabIds.forEach((id, index) => {
      if (!surfaceIds.has(id)) {
        removed.set(id, { cellId: cell.id, index, wasActive: id === cell.activeId });
      }
    });
    const activeId =
      cell.activeId !== null && kept.includes(cell.activeId)
        ? cell.activeId
        : neighborAfterRemoval(cell.tabIds, cell.activeId, kept);
    return { ...cell, tabIds: kept, activeId };
  });

  const assigned = new Set(cellsOf(layout).flatMap((cell) => cell.tabIds));
  const unassigned: string[] = next.surfaces
    .map((surface): string => surface.id)
    .filter((id) => !assigned.has(id));
  const homes: Record<string, string> = { ...layout.homes };
  for (const [id, where] of removed) homes[id] = where.cellId;

  if (unassigned.length > 0) {
    const placements = new Map<string, { index?: number; activate: boolean }>();
    const targets = new Map<string, string>();
    const [replacedId] = removed.size === 1 ? [...removed.keys()] : [];
    const replaced = replacedId === undefined ? undefined : removed.get(replacedId);
    const [only] = unassigned.length === 1 ? unassigned : [];
    if (replacedId !== undefined && replaced !== undefined && only !== undefined) {
      // One surface swapped for another (a folder opened in place, a placeholder replaced):
      // the newcomer takes the old one's seat.
      targets.set(only, replaced.cellId);
      placements.set(only, { index: replaced.index, activate: replaced.wasActive });
      delete homes[replacedId];
    } else {
      for (const id of unassigned) {
        const home = homes[id];
        const target =
          home !== undefined && findCell(layout, home) !== null ? home : layout.focusedCellId;
        targets.set(id, target);
        placements.set(id, { activate: next.activeSurfaceId === id });
      }
    }
    const incoming = new Map<string, string[]>();
    for (const [id, target] of targets) {
      incoming.set(target, [...(incoming.get(target) ?? []), id]);
      delete homes[id];
    }
    layout = mapCells(layout, (cell) => {
      const ids = incoming.get(cell.id);
      if (ids === undefined) return cell;
      const tabIds = [...cell.tabIds];
      let activeId = cell.activeId;
      for (const id of ids) {
        const placement = placements.get(id);
        const index = placement?.index;
        tabIds.splice(index === undefined ? tabIds.length : Math.min(index, tabIds.length), 0, id);
        if (placement?.activate === true) activeId = id;
      }
      return settledCell({ ...cell, tabIds, activeId });
    });
  }
  for (const id of assigned) delete homes[id];
  for (const id of unassigned) delete homes[id];

  const prevActive = prev.activeSurfaceId;
  const nextActive = next.activeSurfaceId;
  const activatedCell =
    nextActive !== null && nextActive !== prevActive ? cellOfSurface(layout, nextActive) : null;
  // Closing the selected tab makes the flat code activate the neighbor at its index, from any
  // cell; that is not the user choosing a cell. Anything else that activates is, and so is an
  // update that is itself a user action other than a close: it may swap the tab for that same neighbor.
  const prevIndex = prev.surfaces.findIndex((surface) => surface.id === prevActive);
  const removalNeighbor =
    prevActive === null || surfaceIds.has(prevActive) || prevIndex < 0
      ? undefined
      : next.surfaces[Math.min(prevIndex, next.surfaces.length - 1)]?.id;
  const deliberate =
    activatedCell !== null &&
    (userAction || nextActive !== removalNeighbor || unassigned.includes(nextActive ?? ""));
  let focusedCellId = layout.focusedCellId;
  if (deliberate && activatedCell !== null) {
    focusedCellId = activatedCell.id;
    layout = mapCells(layout, (cell) =>
      cell.id === activatedCell.id && cell.activeId !== nextActive
        ? { ...cell, activeId: nextActive }
        : cell,
    );
  }
  if (focusedCellId !== layout.focusedCellId) layout = { ...layout, focusedCellId };

  const collapsed = collapse(layout);
  if (collapsed === null) {
    return flatten(stripLayout(next), [], next.activeSurfaceId, undefined);
  }
  if ("sole" in collapsed) {
    return flatten(stripLayout(next), collapsed.sole.tabIds, collapsed.sole.activeId, undefined);
  }
  let final = { ...collapsed.layout, homes: trimHomes(homes) };
  const survivors = cellsOf(final);
  if (!survivors.some((cell) => cell.id === final.focusedCellId)) {
    final = { ...final, focusedCellId: heirOf(layout, final.focusedCellId, survivors) };
  }
  if (prev.layout !== undefined && sameLayout(prev.layout, final)) final = prev.layout;
  else if (next.layout !== undefined && sameLayout(next.layout, final)) final = next.layout;
  const focused = findCell(final, final.focusedCellId);
  return flatten(
    next,
    survivors.flatMap((cell) => cell.tabIds),
    focused?.activeId ?? null,
    final,
  );
}

export type SplitOperation =
  | { kind: "split"; cellId: string; surfaceId: string; direction: SplitDirection }
  | { kind: "move"; surfaceId: string; cellId: string; index?: number }
  | { kind: "focus"; cellId: string }
  | { kind: "ratio"; target: "outer" | 0 | 1; ratio: number }
  /** A reopened surface gets a new id; it should return where the closed one sat. */
  | { kind: "adopt-home"; from: string; to: string };

function soleCellOf(state: SplitState): PanelCell {
  const tabIds = state.surfaces.map((surface): string => surface.id);
  return settledCell({
    id: cellId(1),
    tabIds,
    activeId:
      state.activeSurfaceId !== null && tabIds.includes(state.activeSurfaceId)
        ? state.activeSurfaceId
        : null,
  });
}

function shapeOf(state: SplitState): Shape {
  return state.layout === undefined ? { sole: soleCellOf(state) } : { layout: state.layout };
}

function withoutSurface(shape: Shape, surfaceId: string): Shape | null {
  if ("sole" in shape) {
    const tabIds = shape.sole.tabIds.filter((id) => id !== surfaceId);
    return {
      sole: settledCell({
        ...shape.sole,
        tabIds,
        activeId:
          shape.sole.activeId === surfaceId
            ? neighborAfterRemoval(shape.sole.tabIds, surfaceId, tabIds)
            : shape.sole.activeId,
      }),
    };
  }
  const layout = mapCells(shape.layout, (cell) => {
    if (!cell.tabIds.includes(surfaceId)) return cell;
    const tabIds = cell.tabIds.filter((id) => id !== surfaceId);
    return {
      ...cell,
      tabIds,
      activeId:
        cell.activeId === surfaceId
          ? neighborAfterRemoval(cell.tabIds, surfaceId, tabIds)
          : cell.activeId,
    };
  });
  return collapse(layout);
}

const cellCount = (shape: Shape): number => ("sole" in shape ? 1 : cellsOf(shape.layout).length);

/** A shape back into the state, with the focus on `focusId`. */
function commit<T extends SplitState>(state: T, shape: Shape, focusId: string | null): T {
  if ("sole" in shape) {
    return flatten(stripLayout(state), shape.sole.tabIds, shape.sole.activeId, undefined);
  }
  const layout: PanelLayout =
    focusId !== null && findCell(shape.layout, focusId) !== null
      ? { ...shape.layout, focusedCellId: focusId }
      : shape.layout;
  const cells = cellsOf(layout);
  const focused = findCell(layout, layout.focusedCellId);
  return flatten(
    state,
    cells.flatMap((cell) => cell.tabIds),
    focused?.activeId ?? null,
    layout,
  );
}

/** Directions a cell can still be split in, ignoring the room its size leaves. */
export function allowedSplitDirections(
  layout: PanelLayout | undefined,
  cellIdOfTarget: string | null,
): SplitDirection[] {
  if (layout === undefined) return ["left", "right", "top", "bottom"];
  if (cellsOf(layout).length >= MAX_SPLIT_CELLS) return [];
  const group = layout.groups.find((candidate) =>
    candidate.cells.some((cell) => cell.id === cellIdOfTarget),
  );
  if (group === undefined || group.cells.length > 1) return [];
  return layout.axis === "row" ? ["top", "bottom"] : ["left", "right"];
}

function splitSurface<T extends SplitState>(
  state: T,
  op: Extract<SplitOperation, { kind: "split" }>,
): T {
  const shape = shapeOf(state);
  const source =
    "sole" in shape ? shape.sole : (cellOfSurface(shape.layout, op.surfaceId) ?? undefined);
  if (source === undefined || !source.tabIds.includes(op.surfaceId)) return state;
  const targetId = "sole" in shape ? shape.sole.id : op.cellId;
  if (source.id === targetId && source.tabIds.length < 2) return state;
  const reduced = withoutSurface(shape, op.surfaceId);
  if (reduced === null || cellCount(reduced) >= MAX_SPLIT_CELLS) return state;
  const groupSeq = "sole" in shape ? 1 : shape.layout.seq;
  const added: PanelCell = {
    id: cellId(groupSeq + 1),
    tabIds: [op.surfaceId],
    activeId: op.surfaceId,
  };
  const axis = axisOf(op.direction);
  const order = <C>(existing: C, fresh: C): [C, C] =>
    entersFirst(op.direction) ? [fresh, existing] : [existing, fresh];

  if ("sole" in reduced) {
    const [one, two] = order(reduced.sole, added);
    const layout: PanelLayout = {
      axis,
      ratio: 0.5,
      groups: [
        { cells: [one], ratio: 0.5 },
        { cells: [two], ratio: 0.5 },
      ],
      focusedCellId: added.id,
      seq: groupSeq + 1,
      homes: "layout" in shape ? shape.layout.homes : {},
    };
    return commit(state, { layout }, added.id);
  }
  const layout = reduced.layout;
  const group = layout.groups.find((candidate) => candidate.cells.some((c) => c.id === targetId));
  const target = group?.cells.find((cell) => cell.id === targetId);
  if (group === undefined || target === undefined) return state;
  if (axis === layout.axis || group.cells.length > 1) return state;
  const [firstCell, secondCell] = order(target, added);
  const groups = layout.groups.map((candidate) =>
    candidate === group ? { cells: [firstCell, secondCell], ratio: 0.5 } : candidate,
  );
  const [g0, g1] = groups;
  if (g0 === undefined || g1 === undefined) return state;
  return commit(state, { layout: { ...layout, groups: [g0, g1], seq: groupSeq + 1 } }, added.id);
}

function moveSurface<T extends SplitState>(
  state: T,
  op: Extract<SplitOperation, { kind: "move" }>,
): T {
  const shape = shapeOf(state);
  if ("sole" in shape) {
    const tabIds = shape.sole.tabIds;
    if (!tabIds.includes(op.surfaceId)) return state;
    const rest = tabIds.filter((id) => id !== op.surfaceId);
    const at = Math.min(Math.max(0, op.index ?? rest.length), rest.length);
    const ordered = [...rest.slice(0, at), op.surfaceId, ...rest.slice(at)];
    return commit(
      state,
      { sole: { ...shape.sole, tabIds: ordered, activeId: shape.sole.activeId } },
      null,
    );
  }
  const source = cellOfSurface(shape.layout, op.surfaceId);
  if (source === null || findCell(shape.layout, op.cellId) === null) return state;
  if (source.id === op.cellId) {
    const rest = source.tabIds.filter((id) => id !== op.surfaceId);
    const at = Math.min(Math.max(0, op.index ?? rest.length), rest.length);
    const tabIds = [...rest.slice(0, at), op.surfaceId, ...rest.slice(at)];
    return commit(
      state,
      {
        layout: mapCells(shape.layout, (cell) =>
          cell.id === source.id ? { ...cell, tabIds } : cell,
        ),
      },
      null,
    );
  }
  const reduced = withoutSurface(shape, op.surfaceId);
  if (reduced === null) return state;
  const insert = (cell: PanelCell): PanelCell => {
    const at = Math.min(Math.max(0, op.index ?? cell.tabIds.length), cell.tabIds.length);
    const tabIds = [...cell.tabIds.slice(0, at), op.surfaceId, ...cell.tabIds.slice(at)];
    return { ...cell, tabIds, activeId: op.surfaceId };
  };
  if ("sole" in reduced) {
    return commit(state, { sole: insert(reduced.sole) }, null);
  }
  const target = findCell(reduced.layout, op.cellId);
  if (target === null) return state;
  return commit(
    state,
    { layout: mapCells(reduced.layout, (cell) => (cell.id === op.cellId ? insert(cell) : cell)) },
    op.cellId,
  );
}

/** Applies one user gesture to the split. Refused gestures return `state` untouched. */
export function applySplitOperation<T extends SplitState>(state: T, op: SplitOperation): T {
  switch (op.kind) {
    case "split":
      return splitSurface(state, op);
    case "move":
      return moveSurface(state, op);
    case "focus": {
      if (state.layout === undefined) return state;
      const cell = findCell(state.layout, op.cellId);
      if (cell === null) return state;
      return commit(state, { layout: state.layout }, cell.id);
    }
    case "ratio": {
      const layout = state.layout;
      if (layout === undefined) return state;
      const ratio = clampRatio(op.ratio);
      if (op.target === "outer") {
        return layout.ratio === ratio ? state : { ...state, layout: { ...layout, ratio } };
      }
      const group = layout.groups[op.target];
      if (group === undefined || group.cells.length < 2 || group.ratio === ratio) return state;
      const groups = layout.groups.map((candidate) =>
        candidate === group ? { ...candidate, ratio } : candidate,
      );
      const [g0, g1] = groups;
      return g0 === undefined || g1 === undefined
        ? state
        : { ...state, layout: { ...layout, groups: [g0, g1] } };
    }
    case "adopt-home": {
      const layout = state.layout;
      const home = layout?.homes[op.from];
      if (layout === undefined || home === undefined) return state;
      return { ...state, layout: { ...layout, homes: { ...layout.homes, [op.to]: home } } };
    }
  }
}

/** A saved panel state with its saved layout checked and fitted to the surfaces it holds. */
export function restoreSplit<T extends SplitState>(rawLayout: unknown, state: T): T {
  const layout = sanitizeLayout(rawLayout);
  return layout === null ? state : reconcileSplit(state, { ...state, layout });
}

const resolved = new WeakMap<object, PanelLayout | null>();

/**
 * The layout to draw for a panel state: the saved one, repaired against the surfaces if saved
 * data and surfaces disagree. Not written back; the next store update does that.
 */
export function resolveSplitLayout(state: SplitState): PanelLayout | null {
  if (state.layout === undefined) return null;
  const cached = resolved.get(state);
  if (cached !== undefined) return cached;
  const repaired = reconcileSplit(state, state).layout ?? null;
  resolved.set(state, repaired);
  return repaired;
}

/** Surfaces sharing a cell with `surfaceId`, or all of them when the panel is not split. */
export function surfacesSharingCell<S extends { id: string }>(
  state: { surfaces: readonly S[]; layout?: PanelLayout | undefined },
  surfaceId: string,
): readonly S[] {
  const cell = state.layout === undefined ? null : cellOfSurface(state.layout, surfaceId);
  if (cell === null) return state.surfaces;
  return cell.tabIds.flatMap((id) => {
    const surface = state.surfaces.find((entry) => entry.id === id);
    return surface === undefined ? [] : [surface];
  });
}

/** The cell showing the panel's focus, or null when the panel is not split. */
export function focusedCellOf(layout: PanelLayout | null): PanelCell | null {
  return layout === null ? null : findCell(layout, layout.focusedCellId);
}
