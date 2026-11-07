// @effect-diagnostics nodeBuiltinImport:off -- Event emitters stand in for the WebSocket under the stream.
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";

import { LOOPBACK_GATEWAY_LIMITS } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocket, WebSocketServer } from "ws";

import { openLoopbackTunnel, TunnelSocket } from "./TunnelClient.ts";

class FakeSocket extends NodeEvents.EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: Array<number> = [];
  readonly pending: Array<() => void> = [];
  paused = false;
  closed: number | undefined;
  terminated = false;

  send(data: Buffer, _options: unknown, callback: (error?: Error) => void): void {
    this.sent.push(data.length);
    this.pending.push(() => callback());
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  close(code: number): void {
    this.closed = code;
  }

  terminate(): void {
    this.terminated = true;
  }
}

const open = () => {
  const fake = new FakeSocket();
  return { fake, tunnel: new TunnelSocket(fake as unknown as WebSocket) };
};

const MESSAGE_LIMIT = LOOPBACK_GATEWAY_LIMITS.maxMessageBytes;
const SEND_BUFFER = LOOPBACK_GATEWAY_LIMITS.tunnelSendBufferBytes;

describe("TunnelSocket backpressure", () => {
  it("stops reading the far end once what it holds passes the send buffer, and resumes when drained", () => {
    const { fake, tunnel } = open();
    fake.emit("message", Buffer.alloc(SEND_BUFFER + 1));
    expect(fake.paused).toBe(true);

    while (tunnel.read() !== null) {
      // Draining the readable side is what asks for more.
    }
    expect(fake.paused).toBe(false);
    tunnel.destroy();
  });

  it("keeps reading while it holds less than the send buffer", () => {
    const { fake, tunnel } = open();
    fake.emit("message", Buffer.alloc(1024));
    expect(fake.paused).toBe(false);
    tunnel.destroy();
  });

  it("tells a writer to wait while frames are still being handed to the socket, and lets it go after", async () => {
    const { fake, tunnel } = open();
    const drained = new Promise<void>((resolve) => tunnel.once("drain", () => resolve()));
    expect(tunnel.write(Buffer.alloc(SEND_BUFFER + 1))).toBe(false);
    // Frames go out one at a time, the next only after the socket took the previous one.
    expect(fake.sent).toEqual([MESSAGE_LIMIT]);
    fake.pending.shift()!();
    fake.pending.shift()!();
    await drained;
    expect(fake.sent).toEqual([MESSAGE_LIMIT, 1]);
    tunnel.destroy();
  });

  it("splits a write larger than the message limit into frames no larger than it", () => {
    const { fake, tunnel } = open();
    tunnel.write(Buffer.alloc(MESSAGE_LIMIT * 2 + 5));
    fake.pending.shift()!();
    fake.pending.shift()!();
    fake.pending.shift()!();
    expect(fake.sent).toEqual([MESSAGE_LIMIT, MESSAGE_LIMIT, 5]);
    expect(fake.sent.every((size) => size <= MESSAGE_LIMIT)).toBe(true);
    tunnel.destroy();
  });

  it("closes the WebSocket normally when the writer is done, and ends the readable side when the far end closes", async () => {
    const { fake, tunnel } = open();
    const ended = new Promise<void>((resolve) => tunnel.once("close", () => resolve()));
    tunnel.end();
    await new Promise<void>((resolve) => tunnel.once("finish", () => resolve()));
    expect(fake.closed).toBe(1000);
    fake.emit("close");
    await ended;
    expect(fake.terminated).toBe(true);
  });

  it("destroys the WebSocket with the stream", () => {
    const { fake, tunnel } = open();
    tunnel.destroy();
    expect(fake.terminated).toBe(true);
  });

  it("refuses writes once the WebSocket is not open", async () => {
    const { fake, tunnel } = open();
    fake.readyState = WebSocket.CLOSED;
    tunnel.on("error", () => {});
    const failed = new Promise<Error>((resolve) => tunnel.once("error", resolve));
    tunnel.write("late");
    expect((await failed).message).toBe("Tunnel is closed.");
  });
});

describe("TunnelSocket timeouts", () => {
  it("takes a listener back when the timeout is cleared with it, as net.Socket does", () => {
    const { tunnel } = open();
    // What `http.Agent` does each time it reuses a connection: set a timeout with its listener,
    // and clear it with the same listener when the request is done.
    const listener = () => {};
    for (let reuse = 0; reuse < 25; reuse += 1) {
      tunnel.setTimeout(30_000, listener);
      expect(tunnel.listenerCount("timeout")).toBe(1);
      tunnel.setTimeout(0, listener);
      expect(tunnel.listenerCount("timeout")).toBe(0);
    }
    tunnel.destroy();
  });
});

describe("a frame beyond the message limit", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("closes the tunnel instead of delivering it", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    );
    server.on("connection", (socket) => {
      socket.on("error", () => {});
      socket.send(Buffer.alloc(MESSAGE_LIMIT + 1));
    });
    const { port } = server.address() as NodeNet.AddressInfo;

    const tunnel = await openLoopbackTunnel({
      baseUrl: `http://localhost:${port}`,
      ticket: Redacted.make("ticket-body.signature"),
      port: 4000,
    });
    let delivered = 0;
    tunnel.on("data", (chunk: Buffer) => {
      delivered += chunk.length;
    });
    if (!tunnel.destroyed)
      await new Promise<void>((resolve) => tunnel.once("close", () => resolve()));
    expect(delivered).toBe(0);
    expect(tunnel.destroyed).toBe(true);
  });
});
