// fork: what the proxy is asked to reach, and whether that is something it forwards
// (research/remote-loopback-forwarding.md 1.2). The host test is the shared one, so the proxy and
// Chromium agree on what loopback is; everything else is refused.
import { isLoopbackGatewayHost } from "@t3tools/shared/forkLoopbackGateway/hosts";
import { parseLoopbackGatewayPort } from "@t3tools/shared/forkLoopbackGateway/protocol";

export interface ProxyTarget {
  readonly host: string;
  readonly port: number;
}

// `host`, `host:port`, `[v6]` or `[v6]:port`: no userinfo, path, query, fragment or whitespace.
const AUTHORITY = /^(\[[\da-f:.]+\]|[^\s:@/?#[\]\\]+)(?::(\d+))?$/iu;

type ParsedAuthority =
  | { readonly kind: "target"; readonly target: ProxyTarget }
  | { readonly kind: "refused" }
  | { readonly kind: "malformed" };

const parseAuthority = (authority: string, defaultPort: string | undefined): ParsedAuthority => {
  const match = AUTHORITY.exec(authority);
  if (match === null) return { kind: "malformed" };
  const host = match[1]!;
  const port = parseLoopbackGatewayPort(match[2] ?? defaultPort);
  return port !== null && isLoopbackGatewayHost(host)
    ? { kind: "target", target: { host, port } }
    : { kind: "refused" };
};

/** The authority of a `CONNECT` request line: `host:port`, the port required. */
export const parseConnectTarget = (authority: string): ParsedAuthority =>
  /:\d+$/u.test(authority) ? parseAuthority(authority, undefined) : { kind: "malformed" };

export type ParsedProxyRequest =
  | { readonly kind: "target"; readonly target: ProxyTarget; readonly path: string }
  | { readonly kind: "refused" }
  | { readonly kind: "malformed" };

/**
 * The absolute-form request target of a plain HTTP request to a proxy. `path` is the origin-form
 * remainder exactly as sent, so dot segments and escapes reach the server unchanged.
 */
export const parseProxyRequestUrl = (rawUrl: string): ParsedProxyRequest => {
  const match = /^http:\/\/([^/?#]*)([^#]*)(?:#.*)?$/iu.exec(rawUrl);
  if (match === null) return { kind: "malformed" };
  const parsed = parseAuthority(match[1]!, "80");
  if (parsed.kind !== "target") return parsed;
  const rest = match[2]!;
  const path = rest === "" ? "/" : rest.startsWith("?") ? `/${rest}` : rest;
  return { kind: "target", target: parsed.target, path };
};
