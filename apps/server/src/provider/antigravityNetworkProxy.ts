import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import type * as Undici from "undici";

// fork: one proxy per Antigravity instance, for agy and for T3's own Google quota requests, so both
// leave the machine the same way. There is no per-account proxy.

// undici is external to the CLI bundle; see outboundHttp.ts.
const requireUndici = NodeModule.createRequire(import.meta.url);

const MAX_PROXY_LENGTH = 2_048;
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);
// T3 reaches its MCP bridge over 127.0.0.1; it must never be sent to a proxy.
const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1"];
const PROXY_VARIABLES = new Set(["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]);

const ANTIGRAVITY_NETWORK_PROXY_ISSUE =
  "The Antigravity network proxy must look like http://host:port, https://host:port, socks5://host:port or socks5h://host:port.";

/** The proxy as a URL, or undefined when the setting is empty or not a usable proxy address. */
export function parseAntigravityNetworkProxy(value: string): URL | undefined {
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_PROXY_LENGTH) return undefined;
  const url = URL.parse(text);
  if (
    url === null ||
    !SUPPORTED_PROTOCOLS.has(url.protocol) ||
    url.hostname.length === 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return url;
}

export function antigravityNetworkProxyIssue(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  return parseAntigravityNetworkProxy(value) === undefined ? ANTIGRAVITY_NETWORK_PROXY_ISSUE : null;
}

/**
 * The proxy replaces the machine's own proxy variables, aliases of any case included, and keeps
 * what the machine already exempted. Without a valid proxy the environment is returned untouched.
 */
export function withAntigravityNetworkProxy(
  environment: NodeJS.ProcessEnv,
  proxy: string | undefined,
): NodeJS.ProcessEnv {
  const url = proxy === undefined ? undefined : parseAntigravityNetworkProxy(proxy);
  if (url === undefined) return environment;
  const address = url.href;
  const exempt: string[] = [];
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!PROXY_VARIABLES.has(key.toUpperCase())) {
      result[key] = value;
    } else if (key.toUpperCase() === "NO_PROXY" && value) {
      // A machine-wide `*` would send agy around the proxy while T3's own requests use it.
      exempt.push(
        ...value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "*"),
      );
    }
  }
  const noProxy = [
    ...new Set([...LOOPBACK_BYPASS, ...exempt.filter((entry) => entry.length > 0)]),
  ].join(",");
  return {
    ...result,
    HTTPS_PROXY: address,
    HTTP_PROXY: address,
    ALL_PROXY: address,
    NO_PROXY: noProxy,
    https_proxy: address,
    http_proxy: address,
    all_proxy: address,
    no_proxy: noProxy,
  };
}

/**
 * The dispatcher T3's own Google requests use. `undefined` means no proxy is configured; `null`
 * means one is configured but this runtime cannot use it, and requests must not go out directly.
 */
export const makeAntigravityProxyDispatcher = Effect.fn("makeAntigravityProxyDispatcher")(
  function* (proxy: string | undefined) {
    if (proxy === undefined || proxy.trim().length === 0) return undefined;
    const url = parseAntigravityNetworkProxy(proxy);
    if (url === undefined) return null;
    const undici = requireUndici("undici") as typeof Undici;
    const created = yield* Effect.try({
      try: () => {
        if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
          // undici takes the host name through to the proxy, so socks5 and socks5h resolve alike.
          const socks = new URL(url);
          socks.protocol = "socks5:";
          return new undici.Socks5ProxyAgent(socks);
        }
        // ProxyAgent's own connector forces HTTP/2; see outboundHttp.ts.
        return new undici.ProxyAgent({
          uri: url.href,
          clientFactory: (origin) => new undici.Pool(origin, { allowH2: false }),
        });
      },
      catch: () => null,
    }).pipe(Effect.option);
    if (created._tag === "None") return null;
    yield* Effect.addFinalizer(() => Effect.promise(() => created.value.close()));
    return created.value as Undici.Dispatcher;
  },
);
