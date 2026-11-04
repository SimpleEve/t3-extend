// @effect-diagnostics nodeBuiltinImport:off -- Test fixture: a stand-in for the remote environment's gateway route.
// @effect-diagnostics globalTimers:off -- The fake server pings on a socket timer, as the real route does.
// fork: a fake "B" for the desktop proxy and tunnel client tests. It speaks the wire protocol of
// `@t3tools/shared/forkLoopbackGateway/protocol` (the real route is in the server): it reads the
// ticket from `Authorization`, the port from the query, answers failures with the protocol's status
// and JSON body, and then carries bytes between binary frames and a loopback TCP port.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

import {
  LOOPBACK_GATEWAY_LIMITS,
  LOOPBACK_GATEWAY_PING_INTERVAL_MS,
  LOOPBACK_GATEWAY_PORT_PARAM,
  LOOPBACK_GATEWAY_SERVER_ERROR_STATUS,
  LOOPBACK_GATEWAY_TUNNEL_PATH,
  parseLoopbackGatewayAuthorization,
  parseLoopbackGatewayPort,
  type LoopbackGatewayServerErrorCode,
} from "@t3tools/shared/forkLoopbackGateway/protocol";
import { createWebSocketStream, WebSocketServer } from "ws";

export interface FakeGatewayAttempt {
  readonly port: number | null;
  /** The raw `Authorization` header, kept so tests can assert what reached the server. */
  readonly authorization: string | undefined;
  readonly origin: string | undefined;
}

export interface FakeGatewayOptions {
  /** The ticket the route accepts; any other (or none) is `unauthorized`. */
  readonly ticket: string;
  readonly tls?: { readonly key: string; readonly cert: string };
  /** Refuse a port with one of the route's error codes. */
  readonly refuse?: (port: number) => LoopbackGatewayServerErrorCode | undefined;
  /** Answer every upgrade with this status and a `Location` header, as a misbehaving middlebox would. */
  readonly redirectTo?: string;
  /** Answer every upgrade with a fixed status and body, instead of the route's own behaviour. */
  readonly respondWith?: { readonly status: number; readonly body: string };
  readonly pingIntervalMs?: number;
}

export interface FakeGateway {
  readonly baseUrl: string;
  readonly attempts: ReadonlyArray<FakeGatewayAttempt>;
  /** Tunnels accepted so far. */
  readonly opened: () => number;
  /** Tunnels whose WebSocket is open right now. */
  readonly active: () => number;
  /** Waits until `count` tunnels have closed on the server's side. */
  readonly closed: (count: number) => Promise<void>;
  readonly close: () => Promise<void>;
}

const sendJsonError = (
  socket: NodeStream.Duplex,
  code: LoopbackGatewayServerErrorCode,
  message: string,
): void => {
  const status = LOOPBACK_GATEWAY_SERVER_ERROR_STATUS[code];
  const body = JSON.stringify({ code, message });
  socket.end(
    `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
};

export const startFakeGateway = async (options: FakeGatewayOptions): Promise<FakeGateway> => {
  const attempts: Array<FakeGatewayAttempt> = [];
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LOOPBACK_GATEWAY_LIMITS.maxMessageBytes,
  });
  let opened = 0;
  let active = 0;
  let closedCount = 0;
  const closeWaiters: Array<{ count: number; resolve: () => void }> = [];
  const noteClosed = (): void => {
    closedCount += 1;
    for (const waiter of closeWaiters.splice(0)) {
      if (closedCount >= waiter.count) waiter.resolve();
      else closeWaiters.push(waiter);
    }
  };

  const handler = (_request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    response.writeHead(404).end();
  };
  const server = options.tls
    ? NodeHttps.createServer(options.tls, handler)
    : NodeHttp.createServer(handler);
  const sockets = new Set<NodeStream.Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("secureConnection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const port = parseLoopbackGatewayPort(url.searchParams.get(LOOPBACK_GATEWAY_PORT_PARAM));
    attempts.push({
      port,
      authorization: request.headers.authorization,
      origin: request.headers.origin,
    });
    socket.on("error", () => {});

    if (options.redirectTo !== undefined) {
      socket.end(
        `HTTP/1.1 302 Found\r\nLocation: ${options.redirectTo}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    if (options.respondWith !== undefined) {
      const { status, body } = options.respondWith;
      socket.end(
        `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status] ?? "Status"}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      return;
    }
    if (url.pathname !== LOOPBACK_GATEWAY_TUNNEL_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const ticket = parseLoopbackGatewayAuthorization(request.headers.authorization);
    if (ticket === null || ticket !== options.ticket) {
      sendJsonError(socket, "unauthorized", "Gateway ticket rejected.");
      return;
    }
    if (port === null) {
      sendJsonError(socket, "bad-request", "Invalid port.");
      return;
    }
    const refused = options.refuse?.(port);
    if (refused !== undefined) {
      sendJsonError(socket, refused, "Port refused.");
      return;
    }

    const upstream = NodeNet.connect({ host: "127.0.0.1", port });
    upstream.once("error", () => {
      if (!socket.destroyed && !socket.writableEnded) {
        sendJsonError(socket, "upstream-refused", "Nothing is listening on that port.");
      }
    });
    upstream.once("connect", () => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        opened += 1;
        active += 1;
        const stream = createWebSocketStream(ws);
        const ping = setInterval(
          () => ws.ping(),
          options.pingIntervalMs ?? LOOPBACK_GATEWAY_PING_INTERVAL_MS,
        );
        ping.unref();
        const teardown = () => {
          clearInterval(ping);
          upstream.destroy();
          stream.destroy();
          ws.terminate();
        };
        stream.on("error", teardown);
        upstream.on("error", teardown);
        upstream.once("close", teardown);
        ws.once("close", () => {
          active -= 1;
          teardown();
          noteClosed();
        });
        stream.pipe(upstream);
        upstream.pipe(stream);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;

  return {
    baseUrl: `${options.tls ? "https" : "http"}://localhost:${port}`,
    attempts,
    opened: () => opened,
    active: () => active,
    closed: (count) =>
      closedCount >= count
        ? Promise.resolve()
        : new Promise((resolve) => closeWaiters.push({ count, resolve })),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        for (const client of wss.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
};
