import { useEffect, useReducer, useRef } from "react";

import { useT } from "../../hooks/useT";
import { useAppModalPeek } from "../appModalPeek";
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
import { colorFamilyOfRole } from "./colorFamilies";
import { inspectorReducer } from "./colorInspector.logic";

// fork: the "pick a color from the app" tool of the floating theme editor, in the studio. It
// only finds the color role under the pointer, with the Settings modal hidden so that the whole app
// can be picked from; `themeInspector.ts` does the finding and skips
// anything inside an element marked `data-theme-editor-panel`, which the Colors section is.

export function useColorInspector() {
  const t = useT();
  const [{ phase, selection }, dispatch] = useReducer(inspectorReducer, {
    phase: "idle",
    selection: null,
  });
  // The listeners stay while the uses of a color are shown, and read the phase from here.
  const phaseRef = useRef(phase);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the phase to document listeners that must not be re-registered between a pointer press and its click
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const inspecting = phase !== "idle";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides the Settings modal while picking so the app behind it can be clicked, and brings it back when picking ends or this page goes away
  useEffect(() => {
    if (!inspecting) return;
    useAppModalPeek.getState().setPeeking(true);
    return () => useAppModalPeek.getState().setPeeking(false);
  }, [inspecting]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document pointer, click and key listeners that drive the pick-mode hover overlay
  useEffect(() => {
    if (!inspecting) return;
    const labelOf = (role: ThemeColorRole) => {
      const family = colorFamilyOfRole(role);
      return family ? t(family.label, undefined, "theme color") : getThemeRoleLabel(role);
    };
    // The click that follows the pick is swallowed; the next one goes back to Settings.
    let swallowClick = false;
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
      if (
        phaseRef.current !== "picking" ||
        !(target instanceof Element) ||
        target.closest("[data-theme-editor-panel]")
      ) {
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
      if (phaseRef.current !== "picking") return;
      const inspection =
        hoverTarget === target && hoverInspection
          ? hoverInspection
          : inspectThemeRoleAtElement(target);
      if (!inspection) return;
      clearHover();
      // preventDefault keeps focus put; blur so a focused color field commits its draft first (upstream 21d7feaff7).
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      dispatch({ type: "picked", role: inspection.role });
      swallowClick = true;
    };
    // A click while picking or showing must not press whatever was under the pointer.
    const blockInspectedClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (swallowClick) swallowClick = false;
      else if (phaseRef.current === "showing") dispatch({ type: "back" });
    };
    const cancelInspection = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc leaves picking only; Settings must not see it and close too.
      event.preventDefault();
      event.stopImmediatePropagation();
      clearHover();
      dispatch({ type: "escape" });
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
    if (highlighted === "" || phase !== "showing") return;
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
  }, [highlighted, phase]);

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
    phase,
    selection,
    start: () => dispatch({ type: "start" }),
    back: () => dispatch({ type: "back" }),
    clear: () => dispatch({ type: "cancel" }),
  };
}
