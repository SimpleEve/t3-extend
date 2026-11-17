// A tunnel lives and dies with its session (design 4.8): revocation, expiry, the renewal chain
// of a DPoP-bound session, and revocation racing the upgrade. Every case checks both ends.
// @effect-diagnostics nodeBuiltinImport:off -- Real loopback sockets.
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import { LOOPBACK_GATEWAY_PING_INTERVAL_MS } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  GATEWAY_SCOPES,
  Gateway,
  issueSessionTicket,
  layerGateway,
  listenLoopback,
  makeLayerGateway,
  openTunnel,
} from "./gatewayHarness.testkit.ts";

// Shorter than the tunnel's ping interval (10 s of margin). Past it the test clock fires the
// heartbeat in a tight loop, a pong needs real I/O that does not get a turn under load, and
// three missed pongs terminate the tunnel for a reason other than the one under test.
const LIFETIME = Duration.millis(LOOPBACK_GATEWAY_PING_INTERVAL_MS).pipe(
  Duration.subtract(Duration.seconds(10)),
);

/** Listens now, so a close that happens before the returned effect runs is not missed. */
const closed = (target: { once: (event: "close", listener: () => void) => unknown }) => {
  const done = new Promise<void>((resolve) => target.once("close", () => resolve()));
  return Effect.promise(() => done);
};

/** A service that counts connections and bytes, and hands each socket to the test. */
const countingService = Effect.gen(function* () {
  const state = { connections: 0, bytes: 0 };
  const sockets: Array<NodeNet.Socket> = [];
  const connected = yield* Deferred.make<NodeNet.Socket>();
  const dev = yield* listenLoopback((socket) => {
    state.connections += 1;
    sockets.push(socket);
    socket.on("data", (data) => {
      state.bytes += data.length;
    });
    socket.on("error", () => {});
    Deferred.doneUnsafe(connected, Effect.succeed(socket));
  });
  return { state, sockets, connected, port: dev.port };
});

const openAndCheck = Effect.fn("openAndCheck")(function* (
  port: number,
  ticket: string,
  servicePort: number,
) {
  const attempt = yield* openTunnel(port, { ticket, query: `port=${servicePort}` });
  if (attempt._tag !== "open") return yield* Effect.die(`refused with ${attempt.status}`);
  return attempt.ws;
});

describe("tunnel lifetime", () => {
  it.effect("a revoked session's tunnel closes at both ends and nothing is forwarded after", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const service = yield* countingService;
      const { session, ticket } = yield* issueSessionTicket();
      const ws = yield* openAndCheck(gateway.mainPort, ticket, service.port);
      const socket = yield* Deferred.await(service.connected);
      const wsClosed = closed(ws);
      const serviceClosed = closed(socket);
      yield* gateway.sessions.revoke(session.sessionId);
      yield* wsClosed;
      yield* serviceClosed;
      const bytes = service.state.bytes;
      yield* Effect.sync(() => {
        try {
          ws.send(Buffer.from("after"));
        } catch {
          // The revoked socket is closed; sending into it fails, which is the point.
        }
      });
      assert.equal(service.state.bytes, bytes);
      const again = yield* openTunnel(gateway.mainPort, { ticket, query: `port=${service.port}` });
      assert.equal(again._tag, "refused");
      assert.equal(service.state.connections, 1);
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  describe("a port the user stops allowing", () => {
    const vouchedBy = (owner: "terminal" | "user") => (port: number) =>
      Effect.succeed({ host: "127.0.0.1" as const, port, pid: 1, owner });

    it.effect("closes the tunnels that only the allowed port vouched for, and no others", () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const service = yield* countingService;
        const { ticket } = yield* issueSessionTicket();
        yield* gateway.grants.allow(service.port);
        gateway.setAuthorize(vouchedBy("user"));
        const allowedWs = yield* openAndCheck(gateway.mainPort, ticket, service.port);
        const socket = yield* Deferred.await(service.connected);
        gateway.setAuthorize(vouchedBy("terminal"));
        const terminalWs = yield* openAndCheck(gateway.mainPort, ticket, service.port);

        const wsClosed = closed(allowedWs);
        const serviceClosed = closed(socket);
        yield* gateway.grants.remove(service.port);
        yield* wsClosed;
        yield* serviceClosed;
        // The terminal's tunnel on the same port is not the user's to take away.
        assert.equal(terminalWs.readyState, terminalWs.OPEN);
        const terminalClosed = closed(terminalWs);
        terminalWs.close();
        yield* terminalClosed;
      }).pipe(Effect.scoped, Effect.provide(layerGateway)),
    );

    it.effect("refuses a tunnel whose port was removed while it was being checked", () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const service = yield* countingService;
        const { ticket } = yield* issueSessionTicket();
        // The check said `user`, but the list no longer has the port by the time it is watched.
        gateway.setAuthorize(vouchedBy("user"));
        const attempt = yield* openTunnel(gateway.mainPort, {
          ticket,
          query: `port=${service.port}`,
        });
        assert.equal(attempt._tag, "refused");
        assert.equal(service.state.connections, 0);
      }).pipe(Effect.scoped, Effect.provide(layerGateway)),
    );
  });

  it.effect("closes both ends when the session expires", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const service = yield* countingService;
      const { ticket } = yield* issueSessionTicket({ sessionTtl: LIFETIME });
      const ws = yield* openAndCheck(gateway.mainPort, ticket, service.port);
      const socket = yield* Deferred.await(service.connected);
      const wsClosed = closed(ws);
      const serviceClosed = closed(socket);
      yield* TestClock.adjust(LIFETIME);
      yield* wsClosed;
      yield* serviceClosed;
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.effect(
    "follows a DPoP session's renewals, and the renewal's revocation closes the tunnel",
    () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const echo = yield* listenLoopback((socket) => socket.pipe(socket));
        const first = yield* issueSessionTicket({
          proofKeyThumbprint: "dpop-key-renewal",
          subject: "device",
          sessionTtl: LIFETIME,
        });
        const ws = yield* openAndCheck(gateway.mainPort, first.ticket, echo.port);
        const renewal = yield* gateway.sessions.issue({
          subject: "device",
          method: "dpop-access-token",
          scopes: GATEWAY_SCOPES,
          proofKeyThumbprint: "dpop-key-renewal",
          ttl: Duration.hours(3),
          client: { label: "renewal", deviceType: "desktop" },
        });
        // The first row has expired and the tunnel follows the renewal: it still carries bytes.
        yield* TestClock.adjust(LIFETIME.pipe(Duration.sum(Duration.seconds(1))));
        const reply = Effect.promise(
          () =>
            new Promise<string>((resolve) =>
              ws.once("message", (data: Buffer) => resolve(data.toString())),
            ),
        );
        ws.send(Buffer.from("still here"));
        assert.equal(yield* reply, "still here");
        // A ticket stolen before the renewal opens no new tunnel once its own lifetime is over.
        const wsClosed = closed(ws);
        yield* gateway.sessions.revoke(renewal.sessionId);
        yield* wsClosed;
      }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.effect("revoking the original row of a chain closes the tunnel too", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const service = yield* countingService;
      const first = yield* issueSessionTicket({
        proofKeyThumbprint: "dpop-key-original",
        subject: "device",
      });
      const ws = yield* openAndCheck(gateway.mainPort, first.ticket, service.port);
      const socket = yield* Deferred.await(service.connected);
      yield* gateway.sessions.issue({
        subject: "device",
        method: "dpop-access-token",
        scopes: GATEWAY_SCOPES,
        proofKeyThumbprint: "dpop-key-original",
        client: { label: "renewal", deviceType: "desktop" },
      });
      const wsClosed = closed(ws);
      const serviceClosed = closed(socket);
      yield* gateway.sessions.revoke(first.session.sessionId);
      yield* wsClosed;
      yield* serviceClosed;
      const again = yield* openTunnel(gateway.mainPort, {
        ticket: first.ticket,
        query: `port=${service.port}`,
      });
      assert.equal(again._tag, "refused");
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live("every row of a removed device's session chain is revoked, and every tunnel closes", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const service = yield* countingService;
      const dpop = "dpop-key-chain";
      const rows = [];
      for (let i = 0; i < 3; i++) {
        rows.push(
          yield* issueSessionTicket({ proofKeyThumbprint: dpop, subject: "t3x-device:computer:b" }),
        );
      }
      const sockets = [];
      for (const row of rows) {
        sockets.push(yield* openAndCheck(gateway.mainPort, row.ticket, service.port));
      }
      const waits = [...sockets.map(closed), ...service.sockets.map(closed)];
      // What `DeviceDirectory.reconcile` does to a removed device: revoke every active row.
      for (const active of yield* gateway.sessions.listActive()) {
        if (active.subject === "t3x-device:computer:b") {
          yield* gateway.sessions.revoke(active.sessionId);
        }
      }
      yield* Effect.all(waits, { concurrency: "unbounded" });
      assert.equal(
        (yield* gateway.sessions.listActive()).filter((s) => s.subject === "t3x-device:computer:b")
          .length,
        0,
      );
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );
});

describe("revocation racing the upgrade", () => {
  it.live(
    "a session revoked while the port check is waiting is refused at once, not after it",
    () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const service = yield* countingService;
        const { session, ticket } = yield* issueSessionTicket();
        const entered = yield* Deferred.make<void>();
        const left = yield* Deferred.make<void>();
        // A check that never finishes by itself, like one still in its collection window.
        gateway.setAuthorize((port) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(left, undefined)),
            Effect.as({ host: "127.0.0.1" as const, port, pid: 1, owner: "terminal" as const }),
          ),
        );
        const attempt = yield* Effect.forkChild(
          openTunnel(gateway.mainPort, { ticket, query: `port=${service.port}` }),
        );
        yield* Deferred.await(entered);
        yield* gateway.sessions.revoke(session.sessionId);
        const result = yield* Fiber.join(attempt);
        assert.equal(result._tag, "refused");
        if (result._tag === "refused") assert.equal(result.status, 401);
        // The check was abandoned, not waited for.
        yield* Deferred.await(left);
        assert.equal(service.state.connections, 0);
      }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live("whenever the revocation lands, the outcome is a refusal or a tunnel that closes", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const service = yield* countingService;
      for (let delay = 0; delay < 24; delay++) {
        const { session, ticket } = yield* issueSessionTicket({
          proofKeyThumbprint: `dpop-key-race-${delay}`,
        });
        const upgrade = openTunnel(gateway.mainPort, { ticket, query: `port=${service.port}` });
        const revoke = Effect.gen(function* () {
          for (let i = 0; i < delay; i++) yield* Effect.yieldNow;
          yield* gateway.sessions.revoke(session.sessionId);
        });
        const [attempt] = yield* Effect.all([upgrade, revoke], { concurrency: "unbounded" });
        if (attempt._tag === "open") yield* closed(attempt.ws);
        else assert.equal(attempt.status, 401);
      }
      // Every connection that did reach the service has been closed again.
      yield* Effect.forEach(service.sockets, (socket) =>
        socket.destroyed ? Effect.void : closed(socket),
      );
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );
});

describe("limits on the route", () => {
  it.live("answers 429 past the concurrent limit", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const service = yield* countingService;
      const { ticket } = yield* issueSessionTicket();
      const opened = [
        yield* openAndCheck(gateway.mainPort, ticket, service.port),
        yield* openAndCheck(gateway.mainPort, ticket, service.port),
      ];
      yield* Effect.addFinalizer(() => Effect.sync(() => opened.forEach((ws) => ws.terminate())));
      const third = yield* openTunnel(gateway.mainPort, { ticket, query: `port=${service.port}` });
      assert.equal(third._tag, "refused");
      if (third._tag === "refused") {
        assert.equal(third.status, 429);
        assert.deepEqual((third.body as { code: string }).code, "limit-reached");
      }
    }).pipe(Effect.scoped, Effect.provide(makeLayerGateway({ limits: { tunnelsPerSession: 2 } }))),
  );
});
