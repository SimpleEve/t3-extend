// fork: where the gateway may be used at all (research/remote-loopback-forwarding.md 4.6). The
// ticket is a bearer credential with no proof of possession, so it only travels over TLS, over
// loopback (this machine, or an SSH forward) and over Tailscale's own encryption.
import { isSharedAddressSpaceHost, isTailnetHost } from "../hostClassification.ts";
import { isLoopbackGatewayHost } from "./hosts.ts";
import { LOOPBACK_GATEWAY_PORT_PARAM, LOOPBACK_GATEWAY_TUNNEL_PATH } from "./protocol.ts";

export type LoopbackGatewayTransport =
  | {
      readonly ok: true;
      readonly via: "tls" | "loopback" | "tailnet";
      /** `wss:` for an `https:` base URL, `ws:` otherwise. */
      readonly tunnelProtocol: "wss:" | "ws:";
    }
  | {
      readonly ok: false;
      readonly reason: "insecure-transport" | "invalid-url";
      /** The host is a plain `100.64.0.0/10` address: suggest the MagicDNS name or HTTPS. */
      readonly hint?: "tailscale-address";
    };

/**
 * Whether tunnels may be opened to the environment reached at `httpBaseUrl`, the route actually in
 * use. This decides whether to try, not whether the connection is safe: a TLS certificate still has
 * to pass validation. Tailscale is `isTailnetHost` (MagicDNS or `fd7a:115c:a1e0::/48`); a bare
 * `100.x` address is not, because carrier-grade NAT uses that range too.
 */
export const checkLoopbackGatewayTransport = (httpBaseUrl: string): LoopbackGatewayTransport => {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol === "https:") return { ok: true, via: "tls", tunnelProtocol: "wss:" };
  if (url.protocol !== "http:") return { ok: false, reason: "invalid-url" };
  if (isLoopbackGatewayHost(url.hostname)) {
    return { ok: true, via: "loopback", tunnelProtocol: "ws:" };
  }
  if (isTailnetHost(url.hostname)) return { ok: true, via: "tailnet", tunnelProtocol: "ws:" };
  return isSharedAddressSpaceHost(url.hostname)
    ? { ok: false, reason: "insecure-transport", hint: "tailscale-address" }
    : { ok: false, reason: "insecure-transport" };
};

/** The tunnel URL for `port` on the environment at `httpBaseUrl`, or `null` if the transport check fails. */
export const buildLoopbackGatewayTunnelUrl = (httpBaseUrl: string, port: number): string | null => {
  const transport = checkLoopbackGatewayTransport(httpBaseUrl);
  if (!transport.ok) return null;
  const url = new URL(LOOPBACK_GATEWAY_TUNNEL_PATH, httpBaseUrl);
  url.protocol = transport.tunnelProtocol;
  url.search = new URLSearchParams({ [LOOPBACK_GATEWAY_PORT_PARAM]: String(port) }).toString();
  url.username = "";
  url.password = "";
  return url.toString();
};
