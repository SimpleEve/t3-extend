import "~/index.css";

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { type RightPanelTabsProps } from "../components/RightPanelTabs";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { RightPanelSplitHost } from "./RightPanelSplitHost";
import { cellsOf, resolveSplitLayout } from "./rightPanelSplit";

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

const environmentId = EnvironmentId.make("environment-local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-split"));
const noop = () => {};

const inlineSize = (width: number) => ({
  width,
  handlers: {
    ref: () => undefined,
    onPointerDown: noop,
    onPointerMove: noop,
    onPointerUp: noop,
    onPointerCancel: noop,
    onLostPointerCapture: noop,
  },
  observeRow: () => noop,
});

function Harness(props: {
  readonly width: number;
  readonly closeSurfaces?: (surfaces: readonly RightPanelSurface[]) => void;
}) {
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const layout = resolveSplitLayout(panel);
  const tabs: Omit<
    RightPanelTabsProps,
    "mode" | "inlineSize" | "maximized" | "layoutControls" | "children"
  > = {
    open: true,
    keybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    }),
    surfaces: panel.surfaces,
    environmentId,
    activeSurfaceId: panel.activeSurfaceId,
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onActivate: (surface: RightPanelSurface) =>
      useRightPanelStore.getState().activateSurface(threadRef, surface.id),
    onCloseSurface: (surface: RightPanelSurface) =>
      useRightPanelStore.getState().closeSurface(threadRef, surface.id),
    onCloseOtherSurfaces: noop,
    onCloseSurfacesToRight: noop,
    onCloseAllSurfaces: noop,
    onMoveSurface: noop,
    onCopyFilePath: noop,
    onAddBrowser: noop,
    onAddBrowserInProfile: noop,
    onAddTerminal: noop,
    onAddDiff: noop,
    onAddFiles: noop,
    onAddPullRequest: noop,
    onAddPullRequests: noop,
    onAddDevice: noop,
    browserAvailable: false,
    // fork: the panel draws its add button only while some surface can be added.
    terminalAvailable: true,
    diffAvailable: false,
    filesAvailable: false,
    pullRequestAvailable: false,
    pullRequestsAvailable: false,
    deviceAvailable: false,
  };
  const visible =
    layout === null
      ? panel.surfaces.filter((surface) => surface.id === panel.activeSurfaceId)
      : cellsOf(layout).flatMap((cell) => panel.surfaces.filter((s) => s.id === cell.activeId));
  const contents = new Map(
    visible.map((surface) => [
      surface.id,
      <div key={surface.id} data-test-content={surface.id}>
        {surface.id}
        <button type="button" data-test-button={surface.id}>
          inside
        </button>
        <div data-browser-surface-slot={`guest:${surface.id}`} />
      </div>,
    ]),
  );
  return (
    <RightPanelSplitHost
      tabs={tabs}
      maximized={false}
      inlineSize={inlineSize(props.width)}
      threadRef={threadRef}
      layout={layout}
      contents={contents}
      closeSurfaces={props.closeSurfaces ?? noop}
    />
  );
}

function stage() {
  const element = document.createElement("div");
  element.style.cssText = "width: 1100px; height: 700px; display: flex; justify-content: flex-end";
  return element;
}

/** Three file tabs in one cell, reset when the test ends. */
function seededPanel(): Disposable {
  const reset = () =>
    useRightPanelStore.setState({
      byThreadKey: {},
      threadPanelVisibilityByThreadKey: {},
      userActionRevisionByThreadKey: {},
      closeRevisionByThreadKey: {},
    });
  reset();
  const store = useRightPanelStore.getState();
  store.openFile(threadRef, "a.ts");
  store.openFile(threadRef, "b.ts");
  store.openFile(threadRef, "c.ts");
  return { [Symbol.dispose]: reset };
}

const send = (type: string, target: EventTarget, x: number, y: number, buttons: number) =>
  act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
      }),
    );
  });

/**
 * Drags a tab along `path` with a real pointer sequence. dnd-kit settles on a target one move
 * after the pointer arrives, so the last point is nudged until `settled` holds.
 */
async function drag(
  source: Element,
  path: ReadonlyArray<{ x: number; y: number }>,
  settled: () => void,
) {
  const from = source.getBoundingClientRect();
  await send("pointerdown", source, from.x + from.width / 2, from.y + from.height / 2, 1);
  for (const point of path) await send("pointermove", document, point.x, point.y, 1);
  const last = path[path.length - 1]!;
  let nudge = 0;
  await vi.waitFor(async () => {
    nudge += 1;
    await send("pointermove", document, last.x - (nudge % 2), last.y, 1);
    settled();
  });
  return { drop: () => send("pointerup", document, last.x, last.y, 0) };
}

const tab = (container: HTMLElement, name: string) =>
  [
    ...container.querySelectorAll<HTMLElement>("[data-right-panel-tab-list] [data-active-tab]"),
  ].find((element) => element.textContent?.trim() === name)!;

const panelState = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
const cellTabs = () => {
  const layout = panelState().layout;
  return layout === undefined ? null : cellsOf(layout).map((cell) => [...cell.tabIds]);
};
const previewZone = () =>
  document
    .querySelector("[data-right-panel-drop-preview]")
    ?.getAttribute("data-right-panel-drop-preview");

const cutRight = (surfaceId: string) =>
  useRightPanelStore.getState().applySplit(threadRef, {
    kind: "split",
    cellId: "c1",
    surfaceId,
    direction: "right",
  });

describe("RightPanelSplitHost", () => {
  it("draws one cell until a tab is cut out of it", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    await using screen = await render(<Harness width={900} />, { container: stage() });
    expect(
      screen.container
        .querySelector("[data-right-panel-split]")
        ?.getAttribute("data-right-panel-split"),
    ).toBe("single");
    expect(screen.container.querySelectorAll("[data-right-panel-cell]")).toHaveLength(1);
    expect(
      screen.container.querySelectorAll("[data-right-panel-tab-list] [data-active-tab]"),
    ).toHaveLength(3);
  });

  it("cuts a cell when a tab is dropped on its edge, and shows the cut while dragging", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    await using screen = await render(<Harness width={900} />, { container: stage() });
    const body = screen.container
      .querySelector("[data-right-panel-surface-content]")!
      .getBoundingClientRect();
    const edge = { x: body.right - 20, y: body.top + body.height / 2 };

    const held = await drag(
      tab(screen.container, "c.ts"),
      [{ x: body.left + 100, y: body.top + 100 }, edge],
      () => {
        expect(previewZone()).toBe("right");
        expect(document.querySelector("[data-right-panel-drag-chip]")?.textContent).toBe("c.ts");
        // The tab stays where it was and dims; the chip is what moves.
        const lifted = tab(screen.container, "c.ts");
        expect(lifted.dataset.dragging).toBe("true");
        expect(getComputedStyle(lifted).opacity).toBe("0.4");
        expect(getComputedStyle(lifted).transform).toBe("none");
      },
    );
    await held.drop();

    await vi.waitFor(() => expect(cellTabs()).toEqual([["file:a.ts", "file:b.ts"], ["file:c.ts"]]));
    expect(screen.container.querySelectorAll("[data-right-panel-cell]")).toHaveLength(2);
    expect(screen.container.querySelectorAll("[data-right-panel-divider]")).toHaveLength(1);
    expect(previewZone()).toBeUndefined();
    expect(screen.container.querySelector('[data-test-content="file:c.ts"]')).not.toBeNull();
    expect(screen.container.querySelector('[data-test-content="file:b.ts"]')).not.toBeNull();
  });

  it("moves the last tab of a cell into the other, which folds the panel back to one cell", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    await using screen = await render(<Harness width={900} />, { container: stage() });
    cutRight("file:c.ts");
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll("[data-right-panel-cell]")).toHaveLength(2),
    );
    const target = screen.container
      .querySelectorAll("[data-right-panel-surface-content]")[0]!
      .getBoundingClientRect();

    const held = await drag(
      tab(screen.container, "c.ts"),
      [
        { x: target.left + 30, y: target.top + 60 },
        { x: target.left + target.width / 2, y: target.top + target.height / 2 },
      ],
      () => expect(previewZone()).toBe("center"),
    );
    await held.drop();

    await vi.waitFor(() => expect(panelState().layout).toBeUndefined());
    expect(panelState().surfaces.map((surface) => surface.id)).toEqual([
      "file:a.ts",
      "file:b.ts",
      "file:c.ts",
    ]);
  });

  it("drops a tab from another cell after the tab it is released on when the pointer is on its right half", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    await using screen = await render(<Harness width={900} />, { container: stage() });
    cutRight("file:c.ts");
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll("[data-right-panel-cell]")).toHaveLength(2),
    );
    const target = tab(screen.container, "b.ts").getBoundingClientRect();
    const right = { x: target.right - 4, y: target.top + target.height / 2 };

    const held = await drag(
      tab(screen.container, "c.ts"),
      [{ x: right.x - 30, y: right.y }, right],
      () => {
        expect(document.querySelector("[data-right-panel-drop-preview]")).toBeNull();
      },
    );
    await held.drop();

    await vi.waitFor(() => expect(panelState().layout).toBeUndefined());
    expect(panelState().surfaces.map((surface) => surface.id)).toEqual([
      "file:a.ts",
      "file:b.ts",
      "file:c.ts",
    ]);
  });

  it("folds a layout into one tab strip while the panel is too narrow, and unfolds it when wide", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    cutRight("file:c.ts");
    await using screen = await render(<Harness width={500} />, { container: stage() });
    const area = () => screen.container.querySelector("[data-right-panel-split]");
    await vi.waitFor(() => expect(area()?.getAttribute("data-right-panel-split")).toBe("folded"));
    expect(
      screen.container.querySelectorAll("[data-right-panel-tab-list] [data-active-tab]"),
    ).toHaveLength(3);
    await screen.rerender(<Harness width={900} />);
    await vi.waitFor(() => expect(area()?.getAttribute("data-right-panel-split")).toBe("split"));
    expect(screen.container.querySelectorAll("[data-right-panel-cell]")).toHaveLength(2);
  });

  it("keeps the focused cell's content mounted when the panel crosses the fold width", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    cutRight("file:c.ts");
    await using screen = await render(<Harness width={500} />, { container: stage() });
    const area = () => screen.container.querySelector("[data-right-panel-split]");
    await vi.waitFor(() => expect(area()?.getAttribute("data-right-panel-split")).toBe("folded"));
    const content = screen.container.querySelector('[data-test-content="file:c.ts"]');
    expect(content).not.toBeNull();
    await screen.rerender(<Harness width={900} />);
    await vi.waitFor(() => expect(area()?.getAttribute("data-right-panel-split")).toBe("split"));
    expect(screen.container.querySelector('[data-test-content="file:c.ts"]')).toBe(content);
  });

  it("lets the window be dragged by the tab bars along the top, not by the lower ones", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    cutRight("file:c.ts");
    useRightPanelStore.getState().openFile(threadRef, "d.ts");
    const right = cellsOf(panelState().layout!).find((cell) => cell.tabIds.includes("file:c.ts"))!;
    useRightPanelStore.getState().applySplit(threadRef, {
      kind: "split",
      cellId: right.id,
      surfaceId: "file:d.ts",
      direction: "bottom",
    });
    await using screen = await render(<Harness width={900} />, { container: stage() });
    const region = (element: Element) =>
      getComputedStyle(element).getPropertyValue("-webkit-app-region");
    const bars = () => [
      ...screen.container.querySelectorAll<HTMLElement>("[data-right-panel-tabbar]"),
    ];
    await vi.waitFor(() => expect(bars()).toHaveLength(3));
    expect(bars().map(region)).toEqual(["drag", "drag", "none"]);
    const tabOfLeft = bars()[0]!.querySelector("[data-active-tab]")!;
    expect(region(tabOfLeft)).toBe("no-drag");
  });

  it("takes the focus when a divider is pressed, so the arrow keys then resize it", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    cutRight("file:c.ts");
    await using screen = await render(<Harness width={900} />, { container: stage() });
    const divider = () =>
      screen.container.querySelector<HTMLElement>("[data-right-panel-divider]")!;
    await vi.waitFor(() => expect(divider().getAttribute("aria-valuenow")).toBe("50"));
    await userEvent.click(divider());
    expect(document.activeElement).toBe(divider());
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(panelState().layout?.ratio).toBeCloseTo(0.52));
  });

  it("restores a divider to half on a double click", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    cutRight("file:c.ts");
    useRightPanelStore
      .getState()
      .applySplit(threadRef, { kind: "ratio", target: "outer", ratio: 0.3 });
    await using screen = await render(<Harness width={900} />, { container: stage() });
    const divider = () =>
      screen.container.querySelector<HTMLElement>("[data-right-panel-divider]")!;
    await vi.waitFor(() => expect(divider().getAttribute("aria-valuenow")).toBe("30"));
    await act(async () => {
      divider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await vi.waitFor(() => expect(panelState().layout?.ratio).toBe(0.5));
    expect(divider().getAttribute("aria-valuenow")).toBe("50");
  });

  it("dims the selected tab of a cell that does not hold the focus", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    cutRight("file:c.ts");
    await using screen = await render(<Harness width={900} />, { container: stage() });
    const cells = () => [
      ...screen.container.querySelectorAll<HTMLElement>("[data-right-panel-cell]"),
    ];
    await vi.waitFor(() => expect(cells()).toHaveLength(2));
    expect(cells().map((cell) => cell.dataset.cellFocused)).toEqual(["false", "true"]);
    const background = (cell: HTMLElement) =>
      getComputedStyle(cell.querySelector("[data-active-tab='true']")!).backgroundColor;
    expect(background(cells()[0]!)).not.toBe(background(cells()[1]!));
  });

  it("closes every tab of a folded panel from 'Close all', not just one cell's", async () => {
    await page.viewport(1280, 800);
    using _panel = seededPanel();
    cutRight("file:c.ts");
    const closed: string[][] = [];
    await using screen = await render(
      <Harness width={500} closeSurfaces={(surfaces) => closed.push(surfaces.map((s) => s.id))} />,
      { container: stage() },
    );
    await vi.waitFor(() =>
      expect(
        screen.container
          .querySelector("[data-right-panel-split]")
          ?.getAttribute("data-right-panel-split"),
      ).toBe("folded"),
    );
    await act(async () => {
      tab(screen.container, "a.ts").dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-context-menu="true"]')).not.toBeNull(),
    );
    const item = [
      ...document.querySelectorAll<HTMLElement>('[data-context-menu="true"] button'),
    ].find((button) => button.textContent?.trim().startsWith("Close all"));
    // The menu ignores a pointer click for a moment after it opens.
    await vi.waitFor(async () => {
      await act(async () => item!.click());
      expect(closed).toHaveLength(1);
    });
    expect(closed[0]).toEqual(["file:a.ts", "file:b.ts", "file:c.ts"]);
  });

  describe("which cell holds the focus", () => {
    const focusedCell = (container: HTMLElement) =>
      container
        .querySelector<HTMLElement>("[data-right-panel-cell][data-cell-focused='true']")
        ?.querySelector("[data-test-content]")
        ?.getAttribute("data-test-content");

    async function splitPanel() {
      await page.viewport(1280, 800);
      const panel = seededPanel();
      cutRight("file:c.ts");
      const screen = await render(<Harness width={900} />, { container: stage() });
      await vi.waitFor(() => expect(focusedCell(screen.container)).toBe("file:c.ts"));
      return { panel, screen };
    }

    it("moves to a cell that is pressed with a pointer", async () => {
      const { panel, screen } = await splitPanel();
      using _panel = panel;
      await using _screen = screen;
      const inside = screen.container.querySelector<HTMLElement>("[data-test-button='file:b.ts']")!;
      await send("pointerdown", inside, 10, 10, 1);
      await vi.waitFor(() => expect(focusedCell(screen.container)).toBe("file:b.ts"));
    });

    it("moves to a cell whose add menu is opened", async () => {
      const { panel, screen } = await splitPanel();
      using _panel = panel;
      await using _screen = screen;
      const add = screen.container.querySelectorAll<HTMLElement>(
        "[data-right-panel-cell] button[aria-label='Add panel surface']",
      )[0]!;
      await userEvent.click(add);
      await vi.waitFor(() => expect(focusedCell(screen.container)).toBe("file:b.ts"));
    });

    it("moves to a cell that takes the keyboard focus", async () => {
      const { panel, screen } = await splitPanel();
      using _panel = panel;
      await using _screen = screen;
      await act(async () =>
        screen.container.querySelector<HTMLElement>("[data-test-button='file:b.ts']")!.focus(),
      );
      await vi.waitFor(() => expect(focusedCell(screen.container)).toBe("file:b.ts"));
    });

    it("does not count a press in the cell that already holds the focus as the user acting", async () => {
      const { panel, screen } = await splitPanel();
      using _panel = panel;
      await using _screen = screen;
      const key = scopedThreadKey(threadRef);
      const revision = () => useRightPanelStore.getState().userActionRevisionByThreadKey[key] ?? 0;
      const guest = document.createElement("div");
      guest.dataset.previewViewport = "guest:file:c.ts";
      document.body.append(guest);
      try {
        const before = revision();
        await send("pointerdown", guest, 10, 10, 1);
        await send("pointerdown", guest, 10, 10, 1);
        expect(revision()).toBe(before);
        guest.dataset.previewViewport = "guest:file:b.ts";
        await send("pointerdown", guest, 10, 10, 1);
        expect(revision()).toBeGreaterThan(before);
      } finally {
        guest.remove();
      }
    });

    it("moves to the cell of a browser guest that reports a press", async () => {
      const { panel, screen } = await splitPanel();
      using _panel = panel;
      await using _screen = screen;
      // A guest's wrapper lives outside the cells; its press arrives as a replayed pointerdown.
      const guest = document.createElement("div");
      guest.dataset.previewViewport = "guest:file:b.ts";
      document.body.append(guest);
      try {
        await send("pointerdown", guest, 10, 10, 1);
        await vi.waitFor(() => expect(focusedCell(screen.container)).toBe("file:b.ts"));
      } finally {
        guest.remove();
      }
    });
  });
});
