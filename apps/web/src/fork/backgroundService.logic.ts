import type { BackgroundServiceState } from "@t3tools/shared/backgroundService";

export type BackgroundServiceStatus =
  | "off"
  | "on"
  | "app-missing"
  | "needs-repair"
  | "other-home"
  | "unreadable"
  | "resume-failed";

export interface BackgroundServiceView {
  readonly status: BackgroundServiceStatus;
  /** The switch shows an installed service as on, even one that needs attention. */
  readonly checked: boolean;
  /**
   * Repair and retry-start install again; retry reads the status again. The other cases need the
   * user to act.
   */
  readonly action: "repair" | "retry-start" | "retry" | null;
  /** Why the service did not start at the last quit. */
  readonly reason: string | null;
}

/** `null` hides the row: nothing to switch on this platform, or the state is not known yet. */
export function backgroundServiceView(
  state: BackgroundServiceState | null,
): BackgroundServiceView | null {
  if (state === null || state.kind === "unavailable") return null;
  switch (state.kind) {
    case "off":
      return { status: "off", checked: false, action: null, reason: null };
    case "on":
      return { status: "on", checked: true, action: null, reason: null };
    case "attention":
      return {
        status: state.problem,
        checked: state.problem !== "unreadable",
        action:
          state.problem === "needs-repair"
            ? "repair"
            : state.problem === "resume-failed"
              ? "retry-start"
              : state.problem === "unreadable"
                ? "retry"
                : null,
        reason: state.problem === "resume-failed" ? (state.reason ?? "") : null,
      };
  }
}
