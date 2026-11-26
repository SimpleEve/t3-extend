import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "../lib/utils";

const KEY_STEP = 0.02;

/**
 * Stops browser guests from taking pointer events, so a drag that passes over one keeps
 * reaching the page. Returns the undo.
 */
export function suspendGuestPointerEvents(): () => void {
  const guests = Array.from(document.querySelectorAll<HTMLElement>("[data-preview-viewport]"));
  const previous = guests.map((guest) => guest.style.pointerEvents);
  for (const guest of guests) guest.style.pointerEvents = "none";
  return () => {
    guests.forEach((guest, i) => {
      guest.style.pointerEvents = previous[i] ?? "";
    });
  };
}

/**
 * A line between two panes. While dragged it writes the new ratio straight into a CSS variable
 * on the container, so no React state or store changes per frame; the store is written on release.
 */
export function RightPanelSplitDivider(props: {
  /** `vertical` is a vertical line between side-by-side panes. */
  readonly orientation: "vertical" | "horizontal";
  readonly container: () => HTMLElement | null;
  /** The CSS variable on the container that holds this divider's ratio. */
  readonly ratioVariable: string;
  readonly ratio: number;
  /** Smallest each side may get, in pixels. */
  readonly minSide: number;
  readonly label: string;
  readonly style: CSSProperties;
  readonly onCommit: (ratio: number) => void;
}) {
  const { orientation, container, ratioVariable, ratio, minSide, onCommit } = props;
  const vertical = orientation === "vertical";
  const drag = useRef<{
    pointerId: number;
    origin: number;
    size: number;
    ratio: number;
    restore: () => void;
  } | null>(null);

  const bounds = (size: number): [number, number] => {
    const margin = size > 0 ? Math.min(0.45, minSide / size) : 0.1;
    return [Math.max(0.1, margin), Math.min(0.9, 1 - margin)];
  };

  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    current.restore();
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit) {
      if (current.ratio !== ratio) onCommit(current.ratio);
    } else container()?.style.setProperty(ratioVariable, String(ratio));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const decrease = vertical ? "ArrowLeft" : "ArrowUp";
    const increase = vertical ? "ArrowRight" : "ArrowDown";
    if (event.key !== decrease && event.key !== increase) return;
    event.preventDefault();
    const element = container();
    const size = element === null ? 0 : vertical ? element.clientWidth : element.clientHeight;
    const [low, high] = bounds(size);
    const next = ratio + (event.key === increase ? KEY_STEP : -KEY_STEP);
    onCommit(Math.min(high, Math.max(low, next)));
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={props.label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={10}
      aria-valuemax={90}
      data-right-panel-divider
      className={cn(
        "group absolute z-20 touch-none select-none outline-none",
        vertical
          ? "w-2 -translate-x-1/2 cursor-col-resize"
          : "h-2 -translate-y-1/2 cursor-row-resize",
      )}
      style={props.style}
      onPointerDown={(event) => {
        const element = container();
        if (event.button !== 0 || element === null) return;
        // preventDefault keeps text from being selected while dragging, but also stops the focus.
        event.preventDefault();
        event.currentTarget.focus();
        const rect = element.getBoundingClientRect();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          origin: vertical ? rect.left : rect.top,
          size: vertical ? rect.width : rect.height,
          ratio,
          restore: suspendGuestPointerEvents(),
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current === null || current.pointerId !== event.pointerId || current.size <= 0) return;
        const [low, high] = bounds(current.size);
        const position = vertical ? event.clientX : event.clientY;
        current.ratio = Math.min(high, Math.max(low, (position - current.origin) / current.size));
        container()?.style.setProperty(ratioVariable, String(current.ratio));
      }}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onDoubleClick={() => onCommit(0.5)}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute bg-border transition-colors duration-150 group-hover:bg-primary/60 group-focus-visible:bg-primary/60 group-active:bg-primary/60",
          vertical
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        )}
      />
    </div>
  );
}
