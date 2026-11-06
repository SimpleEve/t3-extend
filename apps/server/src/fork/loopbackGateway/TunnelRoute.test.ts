// The tunnel route over real sockets: a real server on two listeners, a real `ws` client and real
// loopback services. The first group is the technical prerequisite of design 3.3: the upgrade
// works on both listeners, backpressure holds both ways, and the session's end closes both ends.
// @effect-diagnostics nodeBuiltinImport:off -- Real loopback sockets.
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  Gateway,
  issueSessionTicket,
  layerGateway,
  listenLoopback,
  openTunnel,
} from "./gatewayHarness.testkit.ts";
import type * as NodeWS from "@effect/platform-node/NodeWS";

const ports = (gateway: { readonly mainPort: number; readonly tunnelPort: number }) =>
  [
    ["main listener", gateway.mainPort],
    ["tunnel listener", gateway.tunnelPort],
  ] as const;

const MiB = 1024 * 1024;

/** Listens now, so a close that happens before the returned effect runs is not missed. */
const closed = (target: { once: (event: "close", listener: () => void) => unknown }) => {
  const done = new Promise<void>((resolve) => target.once("close", () => resolve()));
  return Effect.promise(() => done);
};

const nextBinary = (ws: NodeWS.WebSocket) =>
  Effect.promise(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        ws.once("message", (data: Buffer) => resolve(data));
        ws.once("close", () => reject(new Error("closed before a message")));
      }),
  );

describe("tunnel route: the upgrade and the byte pipe", () => {
  it.live("pipes bytes both ways on the main listener and on the tunnel listener", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const dev = yield* listenLoopback((socket) => socket.pipe(socket));
      for (const [, port] of ports(gateway)) {
        const { ticket } = yield* issueSessionTicket();
        const attempt = yield* openTunnel(port, { ticket, query: `port=${dev.port}` });
        assert.equal(attempt._tag, "open");
        if (attempt._tag !== "open") return;
        attempt.ws.send(Buffer.from("hello"));
        assert.equal((yield* nextBinary(attempt.ws)).toString(), "hello");
        const last = Buffer.alloc(300_000, 7);
        const received = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              let total = 0;
              attempt.ws.on("message", (data: Buffer) => {
                total += data.length;
                if (total >= last.length) resolve(total);
              });
              attempt.ws.send(last);
            }),
        );
        assert.equal(received, last.length);
        attempt.ws.close();
      }
      assert.deepEqual(gateway.authorizeCalls, [dev.port, dev.port]);
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live("stops reading the service while the client is not reading (service to client)", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const total = 192 * MiB;
      const state = { written: 0, received: 0, worstLead: 0 };
      const chunk = Buffer.alloc(64 * 1024, 1);
      const dev = yield* listenLoopback((socket) => {
        const pump = () => {
          while (state.written < total) {
            state.written += chunk.length;
            if (!socket.write(chunk)) {
              socket.once("drain", pump);
              return;
            }
          }
        };
        socket.on("error", () => {});
        pump();
      });
      const { ticket } = yield* issueSessionTicket();
      const attempt = yield* openTunnel(gateway.mainPort, { ticket, query: `port=${dev.port}` });
      if (attempt._tag !== "open") return assert.fail("the tunnel did not open");
      const { ws } = attempt;
      // A slow reader: one message per turn of the event loop, then the lead of the service over
      // the client is checked. Without backpressure the service has written everything at once.
      const done = yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            ws.on("message", (data: Buffer) => {
              state.received += data.length;
              state.worstLead = Math.max(state.worstLead, state.written - state.received);
              ws.pause();
              setImmediate(() => ws.resume());
              if (state.received >= total) resolve();
            });
          }),
      );
      void done;
      assert.isBelow(state.worstLead, 32 * MiB);
      ws.close();
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live("stops reading the client while the service is not reading (client to service)", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const total = 192 * MiB;
      const frame = Buffer.alloc(256 * 1024, 2);
      const state = { confirmed: 0, received: 0, worstLead: 0 };
      const finished = yield* Deferred.make<void>();
      const dev = yield* listenLoopback((socket) => {
        socket.on("data", (data) => {
          state.received += data.length;
          socket.pause();
          setImmediate(() => socket.resume());
          if (state.received >= total) Deferred.doneUnsafe(finished, Effect.void);
        });
        socket.on("error", () => {});
      });
      const { ticket } = yield* issueSessionTicket();
      const attempt = yield* openTunnel(gateway.mainPort, { ticket, query: `port=${dev.port}` });
      if (attempt._tag !== "open") return assert.fail("the tunnel did not open");
      const { ws } = attempt;
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            const send = () => {
              if (state.confirmed >= total) return resolve();
              ws.send(frame, () => {
                state.confirmed += frame.length;
                state.worstLead = Math.max(state.worstLead, state.confirmed - state.received);
                send();
              });
            };
            send();
          }),
      );
      yield* Deferred.await(finished);
      assert.isBelow(state.worstLead, 32 * MiB);
      ws.close();
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live("closes the other end when either end closes", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const sockets: Array<NodeNet.Socket> = [];
      const connected = yield* Deferred.make<NodeNet.Socket>();
      const dev = yield* listenLoopback((socket) => {
        sockets.push(socket);
        socket.on("error", () => {});
        Deferred.doneUnsafe(connected, Effect.succeed(socket));
      });
      // The client closes: the service's socket is destroyed.
      {
        const { ticket } = yield* issueSessionTicket();
        const attempt = yield* openTunnel(gateway.mainPort, { ticket, query: `port=${dev.port}` });
        if (attempt._tag !== "open") return assert.fail("the tunnel did not open");
        const service = yield* Deferred.await(connected);
        const gone = closed(service);
        attempt.ws.close();
        yield* gone;
      }
      // The service closes: the client's WebSocket closes.
      {
        const next = yield* Deferred.make<NodeNet.Socket>();
        const dev2 = yield* listenLoopback((socket) => {
          socket.on("error", () => {});
          Deferred.doneUnsafe(next, Effect.succeed(socket));
        });
        const { ticket } = yield* issueSessionTicket();
        const attempt = yield* openTunnel(gateway.mainPort, { ticket, query: `port=${dev2.port}` });
        if (attempt._tag !== "open") return assert.fail("the tunnel did not open");
        const service = yield* Deferred.await(next);
        const gone = closed(attempt.ws);
        service.end();
        yield* gone;
      }
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live("closes a tunnel whose frame is larger than a message may be", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const connected = yield* Deferred.make<NodeNet.Socket>();
      const dev = yield* listenLoopback((socket) => {
        socket.on("error", () => {});
        Deferred.doneUnsafe(connected, Effect.succeed(socket));
      });
      const { ticket } = yield* issueSessionTicket();
      const attempt = yield* openTunnel(gateway.mainPort, { ticket, query: `port=${dev.port}` });
      if (attempt._tag !== "open") return assert.fail("the tunnel did not open");
      const service = yield* Deferred.await(connected);
      const serviceClosed = closed(service);
      const clientClosed = closed(attempt.ws);
      attempt.ws.send(Buffer.alloc(2 * MiB, 3));
      yield* clientClosed;
      yield* serviceClosed;
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );
});
