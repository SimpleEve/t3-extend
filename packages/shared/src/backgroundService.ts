// fork: the desktop app's "keep running in the background" switch. Only the main window of the
// packaged macOS app has this bridge; the main process runs the service commands.
export const BACKGROUND_SERVICE_BRIDGE_GLOBAL = "t3xBackgroundServiceBridge";

export type BackgroundServiceProblem =
  /** The app the service runs from was moved or deleted. */
  | "app-missing"
  /** Installed for an older app version or an unrecognised unit; installing again fixes it. */
  | "needs-repair"
  /** The login service belongs to another T3 home. */
  | "other-home"
  /** The status command failed or printed something unexpected. */
  | "unreadable"
  /** The service did not start when the app last quit; `reason` says why. */
  | "resume-failed";

export type BackgroundServiceState =
  /** Not the packaged macOS app: the row is not shown. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "off" }
  | { readonly kind: "on" }
  | {
      readonly kind: "attention";
      readonly problem: BackgroundServiceProblem;
      /** Only for `resume-failed`: the command's own last line. */
      readonly reason?: string;
    };

export interface BackgroundServiceChange {
  readonly state: BackgroundServiceState;
  /** What went wrong when the switch did not take; the state is what the machine reports now. */
  readonly error: string | null;
}

export interface BackgroundServiceBridge {
  readonly getState: () => Promise<BackgroundServiceState>;
  /** Installs the service (true) or removes it (false), then reports the resulting state. */
  readonly setEnabled: (enabled: boolean) => Promise<BackgroundServiceChange>;
}
