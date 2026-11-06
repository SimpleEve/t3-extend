// fork: the tunnel's wire protocol, shared by the server route and the desktop proxy
// (research/remote-loopback-forwarding.md 3.3, 3.7, 4.3, 7.2). Pure values and functions only.
import * as Schema from "effect/Schema";

/** `GET` with a WebSocket upgrade; the target port is in the query, the ticket is in a header. */
export const LOOPBACK_GATEWAY_TUNNEL_PATH = "/api/loopback-gateway/tunnel" as const;
export const LOOPBACK_GATEWAY_PORT_PARAM = "port" as const;
/**
 * A `wsTicket` query parameter on the tunnel route is refused unread (`ticket-in-url`).
 * @public
 */
export const LOOPBACK_GATEWAY_REFUSED_TICKET_PARAM = "wsTicket" as const;

/**
 * `Authorization: T3X-Gateway <ticket>`. A scheme of our own, so that no existing parser of
 * `Bearer` or `DPoP` can mistake the ticket for a session credential.
 */
export const LOOPBACK_GATEWAY_AUTH_SCHEME = "T3X-Gateway" as const;
export const LOOPBACK_GATEWAY_MAX_TICKET_LENGTH = 2048;

export const formatLoopbackGatewayAuthorization = (ticket: string): string =>
  `${LOOPBACK_GATEWAY_AUTH_SCHEME} ${ticket}`;

// RFC 7235 token68, which also covers `base64url(claims).signature`.
const TICKET_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/u;

/**
 * The ticket in an `Authorization` value, or `null`. Accepts exactly one credential whose scheme is
 * exactly `T3X-Gateway`; `Bearer`, `DPoP`, other casings, lists and malformed tickets are `null`.
 */
export const parseLoopbackGatewayAuthorization = (header: string | undefined): string | null => {
  const prefix = `${LOOPBACK_GATEWAY_AUTH_SCHEME} `;
  if (header === undefined || !header.startsWith(prefix)) return null;
  const ticket = header.slice(prefix.length);
  return ticket.length > 0 &&
    ticket.length <= LOOPBACK_GATEWAY_MAX_TICKET_LENGTH &&
    TICKET_PATTERN.test(ticket)
    ? ticket
    : null;
};

/** A decimal port in 1..65535 and nothing else (no sign, no leading zero, no whitespace). */
export const parseLoopbackGatewayPort = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || !/^[1-9]\d{0,4}$/u.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
};

/**
 * Debuggers and container sockets that give a page remote code execution (5.7). The server also
 * excludes debug processes by argv, since an inspector can bind a random port.
 */
export const LOOPBACK_GATEWAY_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  9222, // Chrome DevTools protocol
  9229, // Node inspector
  5858, // legacy Node debugger
  5859,
  2375, // Docker daemon
  2376,
  5005, // JDWP
  5678, // debugpy
]);

/**
 * Why a tunnel was refused or cannot be opened. The server sends the first group as the JSON body
 * of a failed upgrade (`LOOPBACK_GATEWAY_SERVER_ERROR_STATUS`); the desktop proxy raises the rest
 * itself. Both end up in the same error card (design 7.2).
 */
export const LOOPBACK_GATEWAY_SERVER_ERROR_STATUS = {
  "bad-request": 400,
  "ticket-in-url": 400,
  unauthorized: 401,
  forbidden: 403,
  "not-owned": 403,
  reserved: 403,
  "debug-process": 403,
  "discovery-disabled": 403,
  "owner-changed": 409,
  "rate-limited": 429,
  "limit-reached": 429,
  internal: 500,
  "upstream-refused": 502,
} as const;

export const LOOPBACK_GATEWAY_ERROR_CODES = [
  ...(Object.keys(LOOPBACK_GATEWAY_SERVER_ERROR_STATUS) as ReadonlyArray<
    keyof typeof LOOPBACK_GATEWAY_SERVER_ERROR_STATUS
  >),
  /** Raised by the desktop proxy: the environment is unreachable. */
  "offline",
  /** The environment's server does not advertise the capability. */
  "unsupported-server",
  /** The connection route cannot carry a tunnel (relay, or `insecure-transport`). */
  "unsupported-route",
  /** The route is neither TLS, loopback nor Tailscale (`transport.ts`). */
  "insecure-transport",
  /** The server's certificate failed validation (expired, self-signed, wrong host, private CA). */
  "tls-untrusted",
  /** The upgrade was answered with a redirect, which is never followed. */
  "unexpected-redirect",
] as const;

export const LoopbackGatewayErrorCode = Schema.Literals(LOOPBACK_GATEWAY_ERROR_CODES);
export type LoopbackGatewayErrorCode = typeof LoopbackGatewayErrorCode.Type;

export type LoopbackGatewayServerErrorCode = keyof typeof LOOPBACK_GATEWAY_SERVER_ERROR_STATUS;

/**
 * The JSON body of a failed upgrade. `message` is a fixed phrase for logs and never carries
 * request data, headers or the ticket.
 */
export const LoopbackGatewayErrorBody = Schema.Struct({
  code: LoopbackGatewayErrorCode,
  message: Schema.optionalKey(Schema.String),
});
export type LoopbackGatewayErrorBody = typeof LoopbackGatewayErrorBody.Type;

/** The server pings every 30 seconds and closes after 90 seconds without a pong; no idle timeout. */
export const LOOPBACK_GATEWAY_PING_INTERVAL_MS = 30_000;
export const LOOPBACK_GATEWAY_PONG_TIMEOUT_MS = 90_000;
/**
 * The server's dial to the local port gives up after this long.
 * @public
 */
export const LOOPBACK_GATEWAY_DIAL_TIMEOUT_MS = 3_000;

/** Limits and sizes from design 3.7. Tests assert these numbers; change both together. */
export const LOOPBACK_GATEWAY_LIMITS = {
  /** Server: concurrent tunnels per session. */
  tunnelsPerSession: 64,
  /** Server: concurrent tunnels in total. */
  tunnelsPerServer: 256,
  /** Server: per-session token bucket for opening tunnels. */
  tunnelOpenBurst: 60,
  tunnelOpenRefillPerSecond: 30,
  /** Server: tickets issued per session per minute. */
  ticketsPerSessionPerMinute: 30,
  /** Desktop: Chromium connections to one environment's proxy. */
  proxyConnectionsPerEnvironment: 256,
  /** Desktop: tunnels being opened at once for one environment. */
  pendingTunnelOpensPerEnvironment: 32,
  /** Desktop: connections to the proxy that have not sent valid credentials yet. */
  unauthenticatedProxyConnections: 8,
  /** Desktop: new unauthenticated connections per second before they are destroyed unanswered. */
  unauthenticatedProxyConnectionsPerSecond: 20,
  /** Desktop: keep-alive HTTP connections per forwarded port, idle ones closed after 30 seconds. */
  httpConnectionsPerPort: 16,
  httpIdleTimeoutMs: 30_000,
  /** Pause reading the peer once this much is queued for a tunnel. */
  tunnelSendBufferBytes: 1024 * 1024,
  readChunkBytes: 64 * 1024,
  /** A larger WebSocket message closes the tunnel. */
  maxMessageBytes: 1024 * 1024,
} as const;
