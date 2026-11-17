// fork: what the page-unreachable card says when localhost was meant to be forwarded and was not
// (research/remote-loopback-forwarding.md 7.2). Pure: the reason in, the words out.
import type { Translator } from "@t3tools/client-runtime/i18n";
import { parseLoopbackGatewayPort } from "@t3tools/shared/forkLoopbackGateway/protocol";
import type { LoopbackGatewayErrorCode } from "@t3tools/shared/forkLoopbackGateway/protocol";

import type { AllowedPortFailure } from "./allowedPorts";
import type { LoopbackGatewayState } from "./gatewayState";

export type GatewayCardKey =
  | "not-owned"
  | "reserved"
  | "debug-process"
  | "not-loopback"
  | "owner-changed"
  | "upstream-refused"
  | "offline"
  | "forbidden"
  | "unsupported-server"
  | "insecure-transport"
  | "insecure-transport-tailscale"
  | "tls-untrusted"
  | "relay"
  | "discovery-disabled"
  | "limit"
  | "reconnecting"
  /** A restored tab of an environment that was forwarding, held back until it can be reached. */
  | "waiting"
  /** The environment is forwarding but the main process could not be set up for it. */
  | "start-failed"
  | "failed";

/** The card for a refusal the main process reported. */
export const gatewayCardKeyForCode = (code: LoopbackGatewayErrorCode): GatewayCardKey => {
  switch (code) {
    case "not-owned":
    case "reserved":
    case "debug-process":
    case "not-loopback":
    case "owner-changed":
    case "upstream-refused":
    case "offline":
    case "forbidden":
    case "unsupported-server":
    case "insecure-transport":
    case "tls-untrusted":
    case "discovery-disabled":
      return code;
    case "rate-limited":
    case "limit-reached":
      return "limit";
    case "unauthorized":
      return "reconnecting";
    default:
      return "failed";
  }
};

/**
 * The card for a page that failed to load because nothing was forwarding, or `null` when the state
 * gives no reason (it is forwarding, or the user turned it off, or it never applied).
 */
export const gatewayCardKeyForState = (state: LoopbackGatewayState): GatewayCardKey | null => {
  switch (state.state) {
    case "unsupported-server":
      return "unsupported-server";
    case "no-permission":
      return "forbidden";
    case "unsupported-route":
      if (state.reason === "relay") return "relay";
      return state.hint === "tailscale-address"
        ? "insecure-transport-tailscale"
        : "insecure-transport";
    default:
      return null;
  }
};

/** The port a URL points at, or `null` when it is not a plain `http(s)` address. */
export const gatewayCardPort = (url: string): number | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parseLoopbackGatewayPort(parsed.port || (parsed.protocol === "https:" ? "443" : "80"));
  } catch {
    return null;
  }
};

/** Whether the card can send the user to the environment's own browser, where localhost is its own. */
export const gatewayCardOffersMove = (key: GatewayCardKey): boolean => {
  switch (key) {
    case "not-owned":
    case "reserved":
    case "debug-process":
    case "not-loopback":
    case "unsupported-server":
    case "insecure-transport":
    case "insecure-transport-tailscale":
    case "tls-untrusted":
    case "relay":
    case "discovery-disabled":
      return true;
    default:
      return false;
  }
};

/** Whether the card leads with "allow this port": only for a service no terminal or agent started. */
export const gatewayCardOffersAllow = (key: GatewayCardKey): boolean => key === "not-owned";

/** The line under the allow button when the call failed. */
export const describeAllowPortFailure = (failure: AllowedPortFailure, t: Translator): string => {
  switch (failure) {
    case "invalid-port":
      return t("That isn't a valid port.");
    case "reserved":
      return t("T3 keeps this port for itself or for debugging.");
    case "limit-reached":
      return t(
        "At most 64 ports can be allowed. Remove one in Settings → Browser, then try again.",
      );
    case "not-saved":
      return t("Couldn't save the allowed port. Try again.");
    case "failed":
      return t("Couldn't allow this port. Try again.");
  }
};

export const describeGatewayCard = (
  key: GatewayCardKey,
  context: { readonly environment: string; readonly port: number | null },
  t: Translator,
): { readonly title: string; readonly description: string } => {
  const { environment } = context;
  const port = context.port ?? 0;
  switch (key) {
    case "not-owned":
      return {
        title: t("This port isn't served by a T3 terminal or agent"),
        description: t(
          "{environment} only forwards services started by its T3 terminals and agents by default. This one was started some other way, or it has detached from the terminal or agent that started it (for example, moved to the background with nohup). If you trust it, you can allow this port.",
          { environment },
        ),
      };
    case "not-loopback":
      return {
        title: t("This service isn't listening on localhost"),
        description: t(
          "It only listens on another address, which localhost can't reach. Make it listen on 127.0.0.1 as well.",
        ),
      };
    case "reserved":
      return {
        title: t("This port can't be forwarded"),
        description: t("T3 keeps this port for itself or for debugging."),
      };
    case "debug-process":
      return {
        title: t("This service has debugging turned on"),
        description: t(
          "A service started with debugging options such as --inspect can't be forwarded. Restart it without them.",
        ),
      };
    case "owner-changed":
      return {
        title: t("The service on this port just changed"),
        description: t("Reload to try again."),
      };
    case "upstream-refused":
      return {
        title: t("Nothing is listening on port {port} in {environment}", { port, environment }),
        description: t("Start the service, then reload."),
      };
    case "offline":
      return {
        title: t("Can't reach {environment}", { environment }),
        description: t("Check its connection, then reload."),
      };
    case "forbidden":
      return {
        title: t("This connection isn't allowed to forward localhost"),
        description: t("It needs the preview and terminal permissions."),
      };
    case "unsupported-server":
      return {
        title: t("{environment}'s T3 can't forward localhost", { environment }),
        description: t("Update T3 on {environment} to forward it.", { environment }),
      };
    case "insecure-transport":
      return {
        title: t("This connection isn't encrypted, so localhost isn't forwarded"),
        description: t(
          "Connect to {environment} over https, Tailscale (using its MagicDNS name) or SSH to forward it.",
          { environment },
        ),
      };
    case "insecure-transport-tailscale":
      return {
        title: t("This connection isn't encrypted, so localhost isn't forwarded"),
        description: t(
          "This looks like a Tailscale IP address. Use its MagicDNS name (*.ts.net) or https instead.",
        ),
      };
    case "tls-untrusted":
      return {
        title: t("{environment}'s certificate isn't trusted", { environment }),
        description: t(
          "This computer doesn't trust its certificate (private certificate authorities aren't supported yet). Use a certificate from a public authority, or connect over Tailscale.",
        ),
      };
    case "relay":
      return {
        title: t("Connections through T3 Connect can't forward localhost"),
        description: t("Connect to {environment} another way to forward it.", { environment }),
      };
    case "discovery-disabled":
      return {
        title: t("{environment} has port discovery turned off", { environment }),
        description: t("Forwarding needs port discovery to be on there."),
      };
    case "limit":
      return {
        title: t("Too many forwarded connections"),
        description: t("Reload in a moment to try again."),
      };
    case "waiting":
      return {
        title: t("Can't reach {environment}", { environment }),
        description: t("This tab opens by itself once {environment} is connected.", {
          environment,
        }),
      };
    case "start-failed":
      return {
        title: t("Couldn't start localhost forwarding"),
        description: t(
          "Forwarding to {environment} didn't start, so this tab stays closed. Retry, or use this computer's localhost instead.",
          { environment },
        ),
      };
    case "reconnecting":
      return {
        title: t("Reconnecting to {environment}…", { environment }),
        description: t("This page reloads when the connection is back."),
      };
    case "failed":
      return {
        title: t("Couldn't forward localhost:{port}", { port }),
        description: t("Reload to try again."),
      };
  }
};
