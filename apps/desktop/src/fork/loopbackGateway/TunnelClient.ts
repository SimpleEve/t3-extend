// @effect-diagnostics nodeBuiltinImport:off -- Socket-level client of the tunnel route, at the edge of the main process.
// @effect-diagnostics globalTimers:off -- Idle and handshake deadlines on a socket run outside any Effect fiber.
// fork: opens one WebSocket tunnel to a remote environment's loopback gateway
// (research/remote-loopback-forwarding.md 3.2, 3.6). The connection target is the `baseUrl` the
// caller was given and nothing else: redirects are never followed, certificate validation is never
// weakened, and the ticket only ever leaves here as the `Authorization` header.
import * as NodeStream from "node:stream";

import {
  LoopbackGatewayErrorBody,
  LOOPBACK_GATEWAY_LIMITS,
  LOOPBACK_GATEWAY_PONG_TIMEOUT_MS,
  formatLoopbackGatewayAuthorization,
} from "@t3tools/shared/forkLoopbackGateway/protocol";
import { buildLoopbackGatewayTunnelUrl } from "@t3tools/shared/forkLoopbackGateway/transport";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { WebSocket } from "ws";

import {
  classifyConnectError,
  codeForUnexpectedUpgradeStatus,
  GatewayTunnelError,
} from "./tunnelErrors.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const ERROR_BODY_LIMIT_BYTES = 4096;

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(LoopbackGatewayErrorBody));

/**
 * A byte stream over one WebSocket (binary frames, no framing of its own). It has the few
 * `net.Socket` methods Node's HTTP agent calls, so it can serve as an agent's connection.
 */
export class TunnelSocket extends NodeStream.Duplex {
  private idleMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  timeout = 0;
  private readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    super({
      highWaterMark: LOOPBACK_GATEWAY_LIMITS.tunnelSendBufferBytes,
      allowHalfOpen: false,
    });
    this.ws = ws;
    ws.on("message", (data) => {
      this.touch();
      const chunk = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      if (!this.push(chunk)) ws.pause();
    });
    ws.on("ping", () => this.touch());
    ws.on("close", () => {
      this.push(null);
      this.destroy();
    });
    ws.on("error", (error) => this.destroy(error));
    // A broken tunnel is reported by 'close'; a failure that lands before the consumer has
    // attached its own 'error' listener must not become an uncaught exception.
    this.on("error", () => {});
  }

  override _read(): void {
    this.ws.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.touch();
    if (this.ws.readyState !== WebSocket.OPEN) {
      callback(new Error("Tunnel is closed."));
      return;
    }
    // Frames above the server's message limit would close the tunnel, so large writes are split.
    const frames: Array<Buffer> = [];
    for (let at = 0; at < chunk.length; at += LOOPBACK_GATEWAY_LIMITS.maxMessageBytes) {
      frames.push(chunk.subarray(at, at + LOOPBACK_GATEWAY_LIMITS.maxMessageBytes));
    }
    const sendNext = (index: number): void => {
      if (index >= frames.length) {
        callback();
        return;
      }
      this.ws.send(frames[index]!, { binary: true }, (error) =>
        error ? callback(error) : sendNext(index + 1),
      );
    };
    sendNext(0);
  }

  override _final(callback: (error?: Error | null) => void): void {
    // A tunnel has no half-close: when this side is done, both ends go.
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearIdleTimer();
    this.ws.terminate();
    callback(error);
  }

  private touch(): void {
    if (this.idleMs <= 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.emit("timeout"), this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  // The methods below are what `http.Agent` and `http.ClientRequest` call on a socket.
  setKeepAlive(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setTimeout(milliseconds: number, listener?: () => void): this {
    this.idleMs = milliseconds;
    this.timeout = milliseconds;
    if (listener !== undefined) this.once("timeout", listener);
    if (milliseconds > 0) this.touch();
    else this.clearIdleTimer();
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export interface OpenLoopbackTunnelInput {
  /** The environment's `httpBaseUrl`, fixed when the ticket was installed. */
  readonly baseUrl: string;
  readonly ticket: Redacted.Redacted<string>;
  readonly port: number;
}

const readErrorBody = (response: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    const finish = () => resolve(Buffer.concat(chunks).toString("utf8"));
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= ERROR_BODY_LIMIT_BYTES) chunks.push(chunk);
    });
    response.once("end", finish);
    response.once("error", finish);
    response.once("close", finish);
  });

/**
 * Opens a tunnel to `port` on the environment. Rejects with a `GatewayTunnelError` whose code
 * says why; it fails before any connection when `baseUrl` does not pass the transport check.
 */
export const openLoopbackTunnel = (input: OpenLoopbackTunnelInput): Promise<TunnelSocket> =>
  new Promise((resolve, reject) => {
    const url = buildLoopbackGatewayTunnelUrl(input.baseUrl, input.port);
    if (url === null) {
      reject(new GatewayTunnelError("insecure-transport"));
      return;
    }

    const socket = new WebSocket(url, {
      headers: { Authorization: formatLoopbackGatewayAuthorization(Redacted.value(input.ticket)) },
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: LOOPBACK_GATEWAY_LIMITS.maxMessageBytes,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    let settled = false;
    const fail = (error: GatewayTunnelError): void => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(error);
    };

    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        fail(new GatewayTunnelError("unexpected-redirect"));
        return;
      }
      void readErrorBody(response).then((body) => {
        response.destroy();
        const parsed = decodeErrorBody(body);
        fail(
          new GatewayTunnelError(
            Option.isSome(parsed) ? parsed.value.code : codeForUnexpectedUpgradeStatus(status),
          ),
        );
      });
    });
    socket.once("error", (error) => fail(new GatewayTunnelError(classifyConnectError(error))));
    socket.once("close", () => fail(new GatewayTunnelError("offline")));
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      const stream = new TunnelSocket(socket);
      watchTunnelLiveness(socket);
      resolve(stream);
    });
  });

/**
 * The server pings every 30 seconds. A tunnel that has heard nothing for the pong timeout (a
 * half-open connection after the laptop slept, say) is dead and is closed, so the page sees it.
 */
const watchTunnelLiveness = (socket: WebSocket): void => {
  let heard = true;
  const heartbeat = () => {
    heard = true;
  };
  socket.on("ping", heartbeat);
  socket.on("message", heartbeat);
  const timer = setInterval(() => {
    if (!heard) socket.terminate();
    heard = false;
  }, LOOPBACK_GATEWAY_PONG_TIMEOUT_MS);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
};
