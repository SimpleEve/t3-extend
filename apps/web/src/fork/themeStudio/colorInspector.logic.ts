import type { ThemeColorRole } from "../../themePalette";
import { colorFamilyOfRole, locateColorRole } from "./colorFamilies";

// fork: the phases of picking a color from the app. While picking and while showing where the
// color is used, Settings is hidden; going back brings it back with the pick still selected.

export type ColorSelection = Readonly<{
  /** The role whose row is shown, which is the one its family is listed under. */
  role: ThemeColorRole;
  /** Every role that follows it, whose uses are highlighted. */
  roles: ReadonlyArray<ThemeColorRole>;
  /** Picking the same role again still scrolls to it. */
  pick: number;
}>;

export type InspectorState = Readonly<{
  phase: "idle" | "picking" | "showing";
  selection: ColorSelection | null;
}>;

export type InspectorEvent =
  | { type: "start" }
  | { type: "picked"; role: ThemeColorRole }
  | { type: "back" }
  | { type: "escape" }
  | { type: "cancel" };

export function inspectorReducer(state: InspectorState, event: InspectorEvent): InspectorState {
  switch (event.type) {
    case "start":
      return { phase: "picking", selection: null };
    case "picked": {
      if (state.phase !== "picking") return state;
      const { role } = locateColorRole(event.role);
      return {
        phase: "showing",
        selection: {
          role,
          roles: colorFamilyOfRole(role)?.roles ?? [role],
          pick: (state.selection?.pick ?? 0) + 1,
        },
      };
    }
    case "back":
      return state.phase === "showing" ? { phase: "idle", selection: state.selection } : state;
    case "escape":
      return state.phase === "showing"
        ? { phase: "idle", selection: state.selection }
        : { phase: "idle", selection: null };
    case "cancel":
      return { phase: "idle", selection: null };
  }
}
