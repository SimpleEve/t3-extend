// fork: whether a remote environment's tabs have its loopback services forwarded to this computer
// (research/remote-loopback-forwarding.md 8). One pure function; every gate is a field of its input,
// so the answer is the same wherever it is asked.
import { checkLoopbackGatewayTransport } from "@t3tools/shared/forkLoopbackGateway/transport";

export interface LoopbackGatewayInputs {
  /** The desktop app, with the gateway bridge in the main window. */
  readonly hasBridge: boolean;
  /** The environment's loopback is this computer's (this computer's own server, WSL). */
  readonly runsOnThisComputer: boolean;
  /** The route in use; `null` until the environment has one. */
  readonly route: { readonly httpBaseUrl: string; readonly relay: boolean } | null;
  /** The environment advertises the capability; `null` until its configuration has loaded. */
  readonly capability: boolean | null;
  /** The session grants the preview and terminal scopes; `null` until the session is known. */
  readonly permission: boolean | null;
  readonly disabledByUser: boolean;
}

export type LoopbackGatewayState =
  | { readonly state: "active" }
  | { readonly state: "unsupported-server" }
  | {
      readonly state: "unsupported-route";
      readonly reason: "relay" | "insecure-transport";
      readonly hint?: "tailscale-address";
    }
  | { readonly state: "no-permission" }
  | { readonly state: "disabled-by-user" }
  | { readonly state: "not-applicable" }
  /** An input is not known yet, so the answer could still be any of the above. */
  | { readonly state: "unknown" };

const ACTIVE = { state: "active" } as const;
const UNKNOWN = { state: "unknown" } as const;
const NOT_APPLICABLE = { state: "not-applicable" } as const;

/**
 * The first gate that fails decides, in the order a user would fix them: an environment that cannot
 * forward at all, then its connection, then the session, and only then the user's own switch. That
 * last place keeps "stopped by you" for the case where turning it back on would work.
 */
export const resolveLoopbackGatewayState = (input: LoopbackGatewayInputs): LoopbackGatewayState => {
  if (!input.hasBridge || input.runsOnThisComputer) return NOT_APPLICABLE;
  if (input.capability === null) return UNKNOWN;
  if (!input.capability) return { state: "unsupported-server" };
  if (input.route === null) return UNKNOWN;
  if (input.route.relay) return { state: "unsupported-route", reason: "relay" };
  const transport = checkLoopbackGatewayTransport(input.route.httpBaseUrl);
  if (!transport.ok) {
    return transport.reason === "invalid-url"
      ? NOT_APPLICABLE
      : {
          state: "unsupported-route",
          reason: "insecure-transport",
          ...(transport.hint === undefined ? {} : { hint: transport.hint }),
        };
  }
  if (input.permission === null) return UNKNOWN;
  if (!input.permission) return { state: "no-permission" };
  return input.disabledByUser ? { state: "disabled-by-user" } : ACTIVE;
};

export interface LoopbackGatewayGateInput {
  readonly state: LoopbackGatewayState["state"];
  /** The environment is connecting or connected, so what is unknown may soon be known. */
  readonly connecting: boolean;
  readonly registration: "pending" | "registered" | "stopped" | "failed" | undefined;
  /** Forwarding was `active` for this environment the last time it was known (stored on this device). */
  readonly wasActive: boolean;
  readonly disabledByUser: boolean;
}

/**
 * Whether a tab may create its webview now: a forwarded one waits for the main process to know the
 * environment, so a restored tab never loads this computer's own `localhost` first. A formerly
 * forwarding environment stays closed while unknown, reachable or not; others wait only while connecting.
 */
export const isLoopbackGatewayReady = (input: LoopbackGatewayGateInput): boolean => {
  if (input.disabledByUser) return true;
  if (input.state === "unknown") return input.wasActive ? false : !input.connecting;
  return input.state !== "active" || input.registration === "registered";
};

/**
 * What a tab's gate has let through: `plain` is a webview opened while nothing was forwarded (the
 * user's switch, an environment that cannot forward), `forwarding` one opened behind a registered
 * proxy. Only a webview that exists latches, so `canOperate` is part of the input.
 */
export type GateLatch = "closed" | "plain" | "forwarding";

/**
 * The gate's next latch. A forwarding page stays open when the connection drops, because the card
 * covers it and tearing it down helps nobody. A plain page cannot stay once forwarding turns on: it
 * would keep running outside the proxy, so it is unmounted and opened again, forwarded, once the
 * environment is registered.
 */
export const nextGateLatch = (
  latch: GateLatch,
  input: LoopbackGatewayGateInput & { readonly canOperate: boolean },
): GateLatch => {
  if (!input.canOperate) return "closed";
  const registered = input.state === "active" && input.registration === "registered";
  if (latch === "forwarding") return "forwarding";
  if (latch === "plain") {
    if (input.state !== "active" || input.disabledByUser) return "plain";
    return registered ? "forwarding" : "closed";
  }
  if (!isLoopbackGatewayReady(input)) return "closed";
  return registered ? "forwarding" : "plain";
};

/** The tabs of a forwarded environment are held back until it can be reached, and the user has not said otherwise. */
export const isLoopbackGatewayHeld = (
  input: Pick<LoopbackGatewayGateInput, "state" | "wasActive" | "disabledByUser">,
): boolean => input.state === "unknown" && input.wasActive && !input.disabledByUser;
