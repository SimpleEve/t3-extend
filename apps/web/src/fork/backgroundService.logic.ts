import type { BackgroundServiceState } from "@t3tools/shared/backgroundService";

export type BackgroundServiceStatus =
  | "off"
  | "on"
  | "app-missing"
  | "needs-repair"
  | "other-home"
  | "unreadable";

export interface BackgroundServiceView {
  readonly status: BackgroundServiceStatus;
  /** The switch shows an installed service as on, even one that needs attention. */
  readonly checked: boolean;
  /** Re-runs the install (repair) or the status read (retry); the other cases need the user to act. */
  readonly action: "repair" | "retry" | null;
}

/** `null` hides the row: nothing to switch on this platform, or the state is not known yet. */
export function backgroundServiceView(
  state: BackgroundServiceState | null,
): BackgroundServiceView | null {
  if (state === null || state.kind === "unavailable") return null;
  switch (state.kind) {
    case "off":
      return { status: "off", checked: false, action: null };
    case "on":
      return { status: "on", checked: true, action: null };
    case "attention":
      return {
        status: state.problem,
        checked: state.problem !== "unreadable",
        action:
          state.problem === "needs-repair"
            ? "repair"
            : state.problem === "unreadable"
              ? "retry"
              : null,
      };
  }
}
