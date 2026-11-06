// @effect-diagnostics nodeBuiltinImport:off -- A local HTTP proxy server: sockets are the job.
// fork: the per-environment HTTP proxy that Chromium is pointed at
// (research/remote-loopback-forwarding.md 3.2, 3.7, 4.7). It listens on 127.0.0.1 only, wants a
// random password, forwards loopback requests through tunnels that `openTunnel` provides, and
// refuses everything else. It knows nothing about Electron, tickets or the remote environment.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import {
  LOOPBACK_GATEWAY_LIMITS,
  type LoopbackGatewayErrorCode,
} from "@t3tools/shared/forkLoopbackGateway/protocol";

import { parseConnectTarget, parseProxyRequestUrl, type ProxyTarget } from "./proxyTarget.ts";
import { GatewayTunnelError, gatewayErrorPageStatus } from "./tunnelErrors.ts";

export const GATEWAY_ERROR_HEADER = "X-T3x-Gateway-Error";
export const PROXY_USERNAME = "t3x";

export interface ProxyDenial {
  readonly code: LoopbackGatewayErrorCode;
  readonly port: number;
  /** `connect` is a refused `CONNECT` (https, ws): no response page, no webview to name. */
  readonly via: "http" | "connect";
}

export interface LoopbackProxyOptions {
  /** The proxy password; requests without it get a 407 and never reach `openTunnel`. */
  readonly password: string;
  /** Rejects with a `GatewayTunnelError` when no tunnel can be opened. */
  readonly openTunnel: (port: number) => Promise<NodeStream.Duplex>;
  readonly onDenied?: (denial: ProxyDenial) => void;
  /** The HTML of the page shown for a refused navigation. */
  readonly renderErrorPage?: (input: { code: LoopbackGatewayErrorCode; port: number }) => string;
  readonly now?: () => number;
}

export interface LoopbackProxy {
  readonly port: number;
  /** Closes every open tunnel (and so every connection through one); keeps listening. */
  readonly closeTunnels: () => void;
  /** Stops listening and destroys every connection and tunnel. */
  readonly close: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const defaultErrorPage = ({ code, port }: { code: LoopbackGatewayErrorCode; port: number }) =>
  `<!doctype html><meta charset="utf-8"><title>Cannot forward localhost:${port}</title>` +
  `<body style="font:15px system-ui;margin:3em"><h1>Cannot forward localhost:${port}</h1><p>${code}</p>`;

const expectedAuthorization = (password: string): Buffer =>
  Buffer.from(`Basic ${Buffer.from(`${PROXY_USERNAME}:${password}`).toString("base64")}`, "utf8");

const isAuthorized = (header: string | undefined, expected: Buffer): boolean => {
  if (header === undefined) return false;
  const given = Buffer.from(header, "utf8");
  return given.length === expected.length && NodeCrypto.timingSafeEqual(given, expected);
};

class ProxyTunnelAgent extends NodeHttp.Agent {
  private readonly open: () => Promise<NodeStream.Duplex>;

  constructor(open: () => Promise<NodeStream.Duplex>) {
    super({
      keepAlive: true,
      maxSockets: LOOPBACK_GATEWAY_LIMITS.httpConnectionsPerPort,
      maxFreeSockets: LOOPBACK_GATEWAY_LIMITS.httpConnectionsPerPort,
      timeout: LOOPBACK_GATEWAY_LIMITS.httpIdleTimeoutMs,
    });
    this.open = open;
  }

  override createConnection(
    _options: NodeHttp.ClientRequestArgs,
    callback?: (error: Error | null, stream: NodeStream.Duplex) => void,
  ): NodeStream.Duplex | null | undefined {
    this.open().then(
      (stream) => callback?.(null, stream),
      (error: unknown) =>
        callback?.(error instanceof Error ? error : new GatewayTunnelError("offline"), undefined!),
    );
    return undefined;
  }
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export const startLoopbackProxy = async (options: LoopbackProxyOptions): Promise<LoopbackProxy> => {
  const now = options.now ?? Date.now;
  const renderErrorPage = options.renderErrorPage ?? defaultErrorPage;
  const expected = expectedAuthorization(options.password);
  const limits = LOOPBACK_GATEWAY_LIMITS;

  const tunnels = new Set<NodeStream.Duplex>();
  const agents = new Map<number, ProxyTunnelAgent>();
  const rejected = new Set<NodeNet.Socket>();
  let pendingOpens = 0;
  let rejectionWindowStart = 0;
  let rejectionsInWindow = 0;

  const openTunnel = async (port: number): Promise<NodeStream.Duplex> => {
    if (pendingOpens >= limits.pendingTunnelOpensPerEnvironment) {
      throw new GatewayTunnelError("limit-reached");
    }
    pendingOpens += 1;
    try {
      const tunnel = await options.openTunnel(port);
      tunnels.add(tunnel);
      tunnel.once("close", () => tunnels.delete(tunnel));
      return tunnel;
    } finally {
      pendingOpens -= 1;
    }
  };

  const agentFor = (port: number): ProxyTunnelAgent => {
    let agent = agents.get(port);
    if (agent === undefined) {
      agent = new ProxyTunnelAgent(() => openTunnel(port));
      agents.set(port, agent);
    }
    return agent;
  };

  /** True when the request may proceed. Otherwise the connection has been answered or dropped. */
  const authorize = (
    header: string | undefined,
    socket: NodeNet.Socket,
    reply407: () => void,
  ): boolean => {
    if (isAuthorized(header, expected)) return true;
    const time = now();
    if (time - rejectionWindowStart >= 1000) {
      rejectionWindowStart = time;
      rejectionsInWindow = 0;
    }
    rejectionsInWindow += 1;
    if (
      rejectionsInWindow > limits.unauthenticatedProxyConnectionsPerSecond ||
      rejected.size >= limits.unauthenticatedProxyConnections
    ) {
      socket.destroy();
      return false;
    }
    rejected.add(socket);
    socket.once("close", () => rejected.delete(socket));
    reply407();
    return false;
  };

  const deny = (denial: ProxyDenial) => options.onDenied?.(denial);

  const sendErrorPage = (
    res: NodeHttp.ServerResponse,
    code: LoopbackGatewayErrorCode,
    port: number,
  ): void => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = renderErrorPage({ code, port });
    res.writeHead(gatewayErrorPageStatus(code), {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      [GATEWAY_ERROR_HEADER]: code,
      Connection: "close",
    });
    res.end(body);
  };

  const forward = (
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    target: ProxyTarget,
    path: string,
    mode: {
      readonly expectContinue: boolean;
      /** No request body to send; a `GET` with one of these may be retried once on a stale tunnel. */
      readonly bodyless: boolean;
      readonly canRetry: boolean;
    },
  ): void => {
    const headers: NodeHttp.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name.startsWith("proxy-")) continue;
      if (name === "expect" && !mode.expectContinue) continue;
      headers[name] = value;
    }
    const upstream = NodeHttp.request({
      agent: agentFor(target.port),
      method: req.method,
      path,
      host: target.host,
      port: target.port,
      headers,
    });

    let responded = false;
    const closeUpstream = () => upstream.destroy();
    res.once("close", () => {
      if (!res.writableFinished) closeUpstream();
    });
    req.once("error", closeUpstream);

    // Writing before the tunnel is attached would park the body in the request's own buffer, and
    // Node then never reports 'drain' to the pipe once a socket that accepts it all arrives.
    const sendBody = () => {
      if (mode.bodyless) upstream.end();
      else if (upstream.socket !== null) NodeStream.pipeline(req, upstream, () => {});
      else upstream.once("socket", () => NodeStream.pipeline(req, upstream, () => {}));
    };
    if (mode.expectContinue) {
      upstream.once("continue", () => {
        res.writeContinue();
        sendBody();
      });
    } else {
      sendBody();
    }

    upstream.once("response", (upstreamRes) => {
      responded = true;
      const outgoing: Array<string> = [];
      for (let at = 0; at < upstreamRes.rawHeaders.length; at += 2) {
        const name = upstreamRes.rawHeaders[at]!;
        const lower = name.toLowerCase();
        if (HOP_BY_HOP.has(lower) || lower.startsWith("x-t3x-gateway-")) continue;
        outgoing.push(name, upstreamRes.rawHeaders[at + 1]!);
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, outgoing);
      res.flushHeaders();
      NodeStream.pipeline(upstreamRes, res, (error) => {
        if (error !== undefined && error !== null) res.destroy();
      });
    });

    upstream.once("error", (error) => {
      if (responded) {
        res.destroy();
        return;
      }
      // A keep-alive tunnel the server closed while it sat idle: try once more on a fresh one.
      if (mode.canRetry && upstream.reusedSocket && !(error instanceof GatewayTunnelError)) {
        forward(req, res, target, path, { ...mode, canRetry: false });
        return;
      }
      const code = error instanceof GatewayTunnelError ? error.code : "offline";
      if (error instanceof GatewayTunnelError) {
        deny({ code, port: target.port, via: "http" });
      }
      sendErrorPage(res, code, target.port);
    });
  };

  const handleRequest = (
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    expectContinue: boolean,
  ): void => {
    const authorized = authorize(req.headers["proxy-authorization"], req.socket, () => {
      res.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="T3 Extend loopback gateway"',
        "Content-Length": 0,
        Connection: "close",
      });
      res.end();
    });
    if (!authorized) return;

    const parsed = parseProxyRequestUrl(req.url ?? "");
    if (parsed.kind !== "target") {
      res.writeHead(parsed.kind === "refused" ? 403 : 400, { Connection: "close" });
      res.end(
        parsed.kind === "refused"
          ? "Only loopback addresses are forwarded."
          : "Not a proxy request.",
      );
      return;
    }
    const bodyless =
      (req.headers["content-length"] === undefined || req.headers["content-length"] === "0") &&
      req.headers["transfer-encoding"] === undefined;
    forward(req, res, parsed.target, parsed.path, {
      expectContinue,
      bodyless,
      canRetry: bodyless && safeMethods.has(req.method ?? ""),
    });
  };

  const handleConnect = (
    req: NodeHttp.IncomingMessage,
    client: NodeStream.Duplex,
    head: Buffer,
  ): void => {
    const socket = req.socket;
    const closeWith = (status: number, text: string, code?: LoopbackGatewayErrorCode): void => {
      client.end(
        `HTTP/1.1 ${status} ${text}\r\n${code === undefined ? "" : `${GATEWAY_ERROR_HEADER}: ${code}\r\n`}Content-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    };
    if (
      !authorize(req.headers["proxy-authorization"], socket, () =>
        client.end(
          `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="T3 Extend loopback gateway"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        ),
      )
    ) {
      return;
    }
    const parsed = parseConnectTarget(req.url ?? "");
    if (parsed.kind !== "target") {
      closeWith(
        parsed.kind === "refused" ? 403 : 400,
        parsed.kind === "refused" ? "Forbidden" : "Bad Request",
      );
      return;
    }
    const { port } = parsed.target;
    client.on("error", () => client.destroy());
    openTunnel(port).then(
      (tunnel) => {
        if (client.destroyed) {
          tunnel.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) tunnel.write(head);
        tunnel.once("close", () => client.destroy());
        client.once("close", () => tunnel.destroy());
        NodeStream.pipeline(client, tunnel, () => {});
        NodeStream.pipeline(tunnel, client, () => {});
      },
      (error: unknown) => {
        const code = error instanceof GatewayTunnelError ? error.code : "offline";
        deny({ code, port, via: "connect" });
        closeWith(gatewayErrorPageStatus(code), "Tunnel Failed", code);
      },
    );
  };

  const server = NodeHttp.createServer({ keepAliveTimeout: 30_000 });
  server.maxConnections = limits.proxyConnectionsPerEnvironment;
  server.on("request", (req, res) => handleRequest(req, res, false));
  server.on("checkContinue", (req, res) => handleRequest(req, res, true));
  server.on("connect", handleConnect);
  // Chromium sends `CONNECT` for ws:// too, so a plain `Upgrade` request is not expected.
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  const clients = new Set<NodeNet.Socket>();
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const closeTunnels = (): void => {
    for (const agent of agents.values()) agent.destroy();
    agents.clear();
    for (const tunnel of tunnels) tunnel.destroy();
    tunnels.clear();
  };

  return {
    port: (server.address() as NodeNet.AddressInfo).port,
    closeTunnels,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        closeTunnels();
        for (const socket of clients) socket.destroy();
      }),
  };
};
