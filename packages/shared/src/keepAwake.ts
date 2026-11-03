/**
 * Desktop keep-awake guard: the renderer reports whether a thread on this computer is running,
 * and the main process holds an app-suspension block while it is. Only the desktop renderer has
 * this bridge; no RPC reaches it, so a remote client cannot keep this computer awake.
 */
export interface KeepAwakeBridge {
  readonly setActive: (active: boolean) => Promise<void>;
}

export const KEEP_AWAKE_BRIDGE_GLOBAL = "t3xKeepAwakeBridge";
