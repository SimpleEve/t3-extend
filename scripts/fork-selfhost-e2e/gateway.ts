// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - real sockets and a real terminal, driven from plain async code.
// The pieces of the loopback-gateway scenario (research/remote-loopback-forwarding.md 12, 9.4):
// the service a computer's terminal starts, and a client that talks to it the way Chromium talks
// to the desktop proxy: absolute-form HTTP requests and `CONNECT`, both carrying
// `Proxy-Authorization`. The proxy, the tunnel client and the environment state are the desktop
// app's own modules (no Electron), so nothing here re-implements what is being tested.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type { Computer, E2eContext } from "./computer.ts";
import { check, E2eFailure, freePort, ProcessLog } from "./util.ts";

const FIXTURE = NodePath.join(import.meta.dirname, "gateway-fixture.mjs");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface TerminalService {
  readonly port: number;
  /** What the service reports about itself (`listening`, `sse-open`, `sse-closed`, ...). */
  readonly events: ProcessLog;
  readonly stop: () => Promise<void>;
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Starts the fixture service in a terminal opened on `computer` through its RPC, by typing the
 * command into that terminal, and returns once the service says it is listening.
 */
export async function startServiceInTerminal(
  ctx: E2eContext,
  computer: Computer,
  name: string,
): Promise<TerminalService> {
  const events = new ProcessLog(NodePath.join(ctx.workDir, `${name}-events.log`));
  const sockets = new Set<NodeNet.Socket>();
  const notify = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (chunk) => events.append(chunk.toString("utf8")));
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    notify.once("error", reject);
    notify.listen(0, "127.0.0.1", resolve);
  });
  const notifyPort = (notify.address() as NodeNet.AddressInfo).port;
  const port = await freePort();
  const terminal = { threadId: `e2e-${name}`, terminalId: "term-1" };
  const stop = async (): Promise<void> => {
    await computer.call("terminal.close", { ...terminal, deleteHistory: true }).catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => notify.close(() => resolve()));
  };
  try {
    await computer.call("terminal.open", { ...terminal, cwd: ctx.workDir, cols: 120, rows: 30 });
    await computer.call("terminal.write", {
      ...terminal,
      data: `${quote(process.execPath)} ${quote(FIXTURE)} ${port} ${notifyPort}\r`,
    });
    await events.waitFor(/^listening$/mu, {
      label: `the service in ${computer.name}'s terminal to listen`,
      timeoutMs: 60_000,
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { port, events, stop };
}

/**
 * A listener that no terminal of any computer started. It is orphaned on purpose (started by a
 * shell that exits at once, so its parent is launchd): the test then does not depend on what runs
 * this script, which may itself sit under a provider's process tree and be refused for that
 * instead. It exits when the pipe on fd 3 closes, so a script that dies leaves nothing behind.
 */
export async function startServiceOutsideTerminal(
  ctx: E2eContext,
  name: string,
): Promise<{ readonly port: number; readonly stop: () => Promise<void> }> {
  const port = await freePort();
  const log = new ProcessLog(NodePath.join(ctx.workDir, `${name}.log`));
  const script = `
    const net = require("node:net");
    net.createServer((socket) => socket.end("secret")).listen(${port}, "127.0.0.1", () =>
      console.log("pid " + process.pid + " listening"));
    const leash = new net.Socket({ fd: 3 });
    leash.on("close", () => process.exit());
    leash.on("error", () => process.exit());
    leash.resume();`;
  const launcher = NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", '"$0" -e "$1" &', process.execPath, script],
    { cwd: ctx.workDir, stdio: ["ignore", "pipe", "pipe", "pipe"] },
  );
  launcher.stdout?.on("data", (chunk: Buffer) => log.append(chunk.toString("utf8")));
  launcher.stderr?.on("data", (chunk: Buffer) => log.append(chunk.toString("utf8")));
  const leash = launcher.stdio[3];
  const found = await log.waitFor(/pid (\d+) listening/u, {
    label: `${name} to listen`,
    timeoutMs: 30_000,
  });
  const pid = Number(found[1]);
  return {
    port,
    stop: async () => {
      // The pid this very service printed; it closes by itself once the leash is gone.
      leash?.destroy();
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    },
  };
}

const basic = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

export interface ProxyEndpoint {
  readonly port: number;
  readonly authorization: string;
}

export const proxyEndpoint = (credentials: {
  readonly username: string;
  readonly password: string;
  readonly port: number;
}): ProxyEndpoint => ({
  port: credentials.port,
  authorization: basic(credentials.username, credentials.password),
});

export interface ProxyResponse {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

/** `GET http://localhost:<port><path>` through the proxy, to the end of the body. */
export function getViaProxy(
  proxy: ProxyEndpoint,
  port: number,
  path: string,
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path: `http://localhost:${port}${path}`,
        agent: false,
        headers: { Host: `localhost:${port}`, "Proxy-Authorization": proxy.authorization },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

export interface EventStream {
  readonly status: number;
  /** Resolves with the text so far once `pattern` matches it. */
  readonly waitFor: (pattern: RegExp, label: string) => Promise<string>;
  /** Resolves when the connection ends from either side. */
  readonly closed: Promise<void>;
  readonly destroy: () => void;
}

/** `GET http://localhost:<port><path>` through the proxy, left open and read as it arrives. */
export function streamViaProxy(
  proxy: ProxyEndpoint,
  port: number,
  path: string,
): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path: `http://localhost:${port}${path}`,
        agent: false,
        headers: { Host: `localhost:${port}`, "Proxy-Authorization": proxy.authorization },
      },
      (response) => {
        let text = "";
        const waiters = new Set<{ pattern: RegExp; resolve: (text: string) => void }>();
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
          for (const waiter of waiters) {
            if (waiter.pattern.test(text)) {
              waiters.delete(waiter);
              waiter.resolve(text);
            }
          }
        });
        const closed = new Promise<void>((done) => {
          response.once("close", () => done());
          response.once("error", () => done());
        });
        resolve({
          status: response.statusCode ?? 0,
          closed,
          destroy: () => request.destroy(),
          waitFor: (pattern, label) =>
            new Promise((found, fail) => {
              if (pattern.test(text)) {
                found(text);
                return;
              }
              waiters.add({ pattern, resolve: found });
              void closed.then(() => {
                if (!pattern.test(text)) {
                  fail(
                    new E2eFailure(
                      `The stream closed before ${label}; it had received ${JSON.stringify(text)}.`,
                    ),
                  );
                }
              });
            }),
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

/** What a refused `CONNECT` looks like: the status line and the gateway's error header. */
export function connectViaProxy(
  proxy: ProxyEndpoint,
  port: number,
): Promise<{
  readonly status: number;
  readonly gatewayError: string | undefined;
  readonly socket: NodeNet.Socket;
  readonly rest: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(proxy.port, "127.0.0.1", () => {
      socket.write(
        `CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost:${port}\r\nProxy-Authorization: ${proxy.authorization}\r\n\r\n`,
      );
    });
    socket.once("error", reject);
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const head = buffer.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(/^HTTP\/1\.\d (\d{3})/u.exec(head[0] ?? "")?.[1] ?? 0);
      const header = head.find((line) => /^x-t3x-gateway-error:/iu.test(line));
      resolve({
        status,
        gatewayError: header?.slice(header.indexOf(":") + 1).trim(),
        socket,
        rest: buffer.subarray(end + 4),
      });
    };
    socket.on("data", onData);
  });
}

const maskedTextFrame = (text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  check(payload.length <= 125, "a client test frame is small");
  const mask = NodeCrypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] = masked[i]! ^ mask[i % 4]!;
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
};

export interface ProxiedWebSocket {
  readonly send: (text: string) => void;
  /** The next text message from the service. */
  readonly next: () => Promise<string>;
  readonly closed: Promise<void>;
  readonly destroy: () => void;
}

/** A WebSocket to `localhost:<port><path>`: `CONNECT` through the proxy, then the upgrade by hand. */
export async function webSocketViaProxy(
  proxy: ProxyEndpoint,
  port: number,
  path: string,
): Promise<ProxiedWebSocket> {
  const connected = await connectViaProxy(proxy, port);
  check(connected.status === 200, `CONNECT to localhost:${port} answered ${connected.status}`);
  const { socket } = connected;
  const key = NodeCrypto.randomBytes(16).toString("base64");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  const closed = new Promise<void>((done) => socket.once("close", () => done()));
  socket.on("error", () => {});
  let buffer = connected.rest;
  const messages: Array<string> = [];
  const waiting: Array<(text: string) => void> = [];
  let handshakeDone = false;
  const handshake = new Promise<void>((resolve, reject) => {
    const parse = () => {
      if (handshakeDone) {
        for (;;) {
          if (buffer.length < 2) return;
          const length = buffer[1]! & 0x7f;
          check(length <= 125, "a service test frame is small");
          if (buffer.length < 2 + length) return;
          const opcode = buffer[0]! & 0x0f;
          const payload = buffer.subarray(2, 2 + length).toString("utf8");
          buffer = buffer.subarray(2 + length);
          if (opcode !== 1) continue;
          const waiter = waiting.shift();
          if (waiter === undefined) messages.push(payload);
          else waiter(payload);
        }
      }
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString("latin1");
      const expected = NodeCrypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
      if (!/^HTTP\/1\.1 101 /u.test(head) || !head.includes(`Sec-WebSocket-Accept: ${expected}`)) {
        reject(
          new E2eFailure(
            `The WebSocket upgrade through the tunnel failed: ${head.split("\r\n")[0]}`,
          ),
        );
        return;
      }
      handshakeDone = true;
      buffer = buffer.subarray(end + 4);
      resolve();
      parse();
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    });
    parse();
    void closed.then(() =>
      reject(new E2eFailure("The tunnel closed during the WebSocket upgrade.")),
    );
  });
  await handshake;
  return {
    send: (text) => void socket.write(maskedTextFrame(text)),
    next: () =>
      new Promise((resolve, reject) => {
        const queued = messages.shift();
        if (queued !== undefined) resolve(queued);
        else {
          waiting.push(resolve);
          void closed.then(() =>
            reject(new E2eFailure("The WebSocket closed before a message came.")),
          );
        }
      }),
    closed,
    destroy: () => socket.destroy(),
  };
}
