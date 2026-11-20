import { useEffect, useState } from "react";

import { useT } from "../../hooks/useT";
import {
  clearThemeInspectorHighlights,
  clearThemeInspectorHover,
  highlightThemeRoleUsage,
  inspectThemeRoleAtElement,
  inspectThemeRoleFromUtilitiesAtElement,
  refreshThemeInspectorSpotlight,
  showThemeInspectorHover,
  type ThemeElementInspection,
} from "../../components/settings/themeInspector";
import { getThemeRoleLabel } from "../../components/settings/ThemeColorPicker";
import type { ThemeColorRole } from "../../themePalette";
import { colorFamilyOfRole, locateColorRole } from "./colorFamilies";

// fork: the "pick a color from the app" tool of the floating theme editor, in the studio. It
// only finds the color role under the pointer; `themeInspector.ts` does the finding and skips
// anything inside an element marked `data-theme-editor-panel`, which the Colors section is.

export type ColorSelection = Readonly<{
  /** The role whose row is shown, which is the one its family is listed under. */
  role: ThemeColorRole;
  /** Every role that follows it, whose uses are highlighted. */
  roles: ReadonlyArray<ThemeColorRole>;
  /** Picking the same role again still scrolls to it. */
  pick: number;
}>;

export function useColorInspector() {
  const t = useT();
  const [inspecting, setInspecting] = useState(false);
  const [selection, setSelection] = useState<ColorSelection | null>(null);

  const stop = () => setInspecting(false);
  const clear = () => {
    setInspecting(false);
    setSelection(null);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document pointer, click and key listeners that drive the pick-mode hover overlay
  useEffect(() => {
    if (!inspecting) return;
    const labelOf = (role: ThemeColorRole) => {
      const family = colorFamilyOfRole(role);
      return family ? t(family.label, undefined, "theme color") : getThemeRoleLabel(role);
    };
    let disarmAfterClick = false;
    let hoverTarget: Element | null = null;
    let hoverInspection: ThemeElementInspection | null = null;
    let hoverTimer: number | null = null;
    let hoverFrame: number | null = null;
    const clearHoverTimer = () => {
      if (hoverTimer === null) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    };
    const clearHover = () => {
      clearHoverTimer();
      hoverTarget = null;
      hoverInspection = null;
      clearThemeInspectorHover();
    };
    const showInspection = (inspection: ThemeElementInspection) => {
      hoverInspection = inspection;
      showThemeInspectorHover(inspection, labelOf(inspection.role));
    };
    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) {
        clearHover();
        return;
      }
      clearHoverTimer();
      hoverTarget = target;
      hoverInspection = null;
      const utilityInspection = inspectThemeRoleFromUtilitiesAtElement(target);
      if (utilityInspection) {
        showInspection(utilityInspection);
        return;
      }
      clearThemeInspectorHover();
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (hoverTarget !== target || !target.isConnected) return;
        const inspection = inspectThemeRoleAtElement(target);
        if (inspection) showInspection(inspection);
      }, 140);
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) clearHover();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      clearHoverTimer();
      const inspection =
        hoverTarget === target && hoverInspection
          ? hoverInspection
          : inspectThemeRoleAtElement(target);
      if (!inspection) return;
      clearHover();
      const { role } = locateColorRole(inspection.role);
      setSelection((current) => ({
        role,
        roles: colorFamilyOfRole(role)?.roles ?? [role],
        pick: (current?.pick ?? 0) + 1,
      }));
      disarmAfterClick = true;
    };
    // The click that ends a pick must not press whatever was under the pointer.
    const blockInspectedClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (disarmAfterClick) setInspecting(false);
      disarmAfterClick = false;
    };
    const cancelInspection = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc leaves picking only; Settings must not see it and close too.
      event.preventDefault();
      event.stopImmediatePropagation();
      clearHover();
      setInspecting(false);
      setSelection(null);
    };
    const refreshHover = () => {
      if (!hoverInspection || hoverFrame !== null) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = null;
        if (hoverInspection)
          showThemeInspectorHover(hoverInspection, labelOf(hoverInspection.role));
      });
    };

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", blockInspectedClick, true);
    document.addEventListener("keydown", cancelInspection, true);
    window.addEventListener("resize", refreshHover);
    window.addEventListener("scroll", clearHover, true);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", blockInspectedClick, true);
      document.removeEventListener("keydown", cancelInspection, true);
      window.removeEventListener("resize", refreshHover);
      window.removeEventListener("scroll", clearHover, true);
      clearHoverTimer();
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      clearThemeInspectorHover();
    };
  }, [inspecting, t]);

  const highlighted = selection?.roles.join(",") ?? "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints an overlay over the roles' uses in the DOM and keeps it in place on resize and scroll
  useEffect(() => {
    if (highlighted === "" || inspecting) return;
    highlightThemeRoleUsage(highlighted.split(",") as Array<ThemeColorRole>);
    let frame: number | null = null;
    const refresh = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        refreshThemeInspectorSpotlight();
      });
    };
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      clearThemeInspectorHighlights();
    };
  }, [highlighted, inspecting]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaving the page must not leave the hover or usage overlays painted
  useEffect(
    () => () => {
      clearThemeInspectorHover();
      clearThemeInspectorHighlights();
    },
    [],
  );

  return {
    inspecting,
    selection,
    start: () => {
      setSelection(null);
      setInspecting(true);
    },
    stop,
    clear,
  };
}
