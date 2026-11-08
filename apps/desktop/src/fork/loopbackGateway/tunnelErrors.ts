// fork: why a tunnel could not be opened, and how that shows up on the page
// (research/remote-loopback-forwarding.md 3.6, 7.2).
import {
  LOOPBACK_GATEWAY_SERVER_ERROR_STATUS,
  type LoopbackGatewayErrorCode,
} from "@t3tools/shared/forkLoopbackGateway/protocol";

/** Carries a code and a fixed message only: never a header, a URL or a ticket. */
// @effect-diagnostics-next-line extendsNativeError:off - fork: crosses the node:net/undici callback boundary, where callers match on `code`.
export class GatewayTunnelError extends Error {
  override readonly name = "GatewayTunnelError";
  readonly code: LoopbackGatewayErrorCode;

  constructor(code: LoopbackGatewayErrorCode) {
    super(`Loopback gateway tunnel refused: ${code}`);
    this.code = code;
  }
}

/**
 * Node's certificate validation failures. Any of them is `tls-untrusted`; every other network
 * error is `offline`. The set was measured against real TLS servers (self-signed, expired,
 * wrong host, incomplete chain) in `TunnelClient.test.ts`.
 */
const TLS_CERTIFICATE_ERROR_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_CHAIN_TOO_LONG",
  "INVALID_CA",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const isTlsCertificateError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  TLS_CERTIFICATE_ERROR_CODES.has(error.code);

export const classifyConnectError = (error: unknown): LoopbackGatewayErrorCode =>
  isTlsCertificateError(error) ? "tls-untrusted" : "offline";

/**
 * The HTTP status of the error page the proxy answers a page with. `unauthorized` is a 503: the
 * ticket is being renewed, and a 401 or 407 could be taken for a challenge by the page.
 */
export const gatewayErrorPageStatus = (code: LoopbackGatewayErrorCode): number => {
  switch (code) {
    case "unauthorized":
      return 503;
    case "forbidden":
    case "not-owned":
    case "reserved":
    case "debug-process":
    case "discovery-disabled":
    case "owner-changed":
    case "rate-limited":
    case "limit-reached":
      return LOOPBACK_GATEWAY_SERVER_ERROR_STATUS[code];
    default:
      return 502;
  }
};

/** The error code each failed-upgrade status means when the body is not a gateway error. */
export const codeForUnexpectedUpgradeStatus = (status: number): LoopbackGatewayErrorCode => {
  if (status >= 300 && status < 400) return "unexpected-redirect";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  // The route does not exist on an older or upstream server, or a catch-all answered it.
  if (status === 200 || status === 404 || status === 405) return "unsupported-server";
  return "offline";
};
