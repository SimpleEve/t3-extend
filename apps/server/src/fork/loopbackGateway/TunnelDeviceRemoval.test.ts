// A device removed from the registry loses its tunnels: the real `DeviceDirectory` sync finds the
// device gone, revokes every active row of its session chain, and each tunnel of that chain closes at
// both ends (design 4.8, 8.2). Other devices' tunnels are not touched. The directory, the registry
// fake and the session store are the 8.2 harness's; the tunnel route is the production one.
// @effect-diagnostics nodeBuiltinImport:off -- Real loopback sockets.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as DeviceDirectory from "../deviceKeys/DeviceDirectory.ts";
import { NOW_MS, joinThisComputer, layerHarness } from "../deviceKeys/deviceHarness.testkit.ts";
import { FakeRegistry } from "../deviceKeys/registryFake.testkit.ts";
import { GatewayAvailabilityOverride } from "./GatewayAvailability.ts";
import { GATEWAY_SCOPES, listenLoopback, openTunnel } from "./gatewayHarness.testkit.ts";
import * as PortAuthorizer from "./PortAuthorizer.ts";
import * as TunnelRoute from "./TunnelRoute.ts";

const closed = (target: { once: (event: "close", listener: () => void) => unknown }) => {
  const done = new Promise<void>((resolve) => target.once("close", () => resolve()));
  return Effect.promise(() => done);
};

/** The production tunnel route on its own listener, over the harness's session store. */
const gatewayServer = Effect.gen(function* () {
  const layerPlatform = HttpPlatform.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
    Layer.provideMerge(Etag.layerWeak),
  );
  const context = yield* Layer.build(
    HttpRouter.serve(TunnelRoute.layer, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(
        Layer.succeed(PortAuthorizer.PortAuthorizer, {
          authorize: (port: number) => Effect.succeed({ host: "127.0.0.1" as const, port, pid: 1 }),
        }),
      ),
      Layer.provide(Layer.succeed(GatewayAvailabilityOverride, { available: true })),
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: 0 }),
      ),
      Layer.provide(layerPlatform),
    ),
  );
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (!("port" in address)) return yield* Effect.die("Expected a TCP address.");
  return address.port;
});

describe("device removal reaches the tunnels", () => {
  it.effect(
    "the registry dropping a device revokes its whole session chain and closes its tunnels",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fake = yield* FakeRegistry;
        const directory = yield* DeviceDirectory.DeviceDirectory;
        const sessions = yield* SessionStore.SessionStore;
        yield* joinThisComputer();
        const laptop = fake.addDevice({ kind: "computer", name: "Laptop", environmentId: "env-l" });
        const tablet = fake.addDevice({ kind: "computer", name: "Tablet", environmentId: "env-t" });
        yield* directory.sync;
        const port = yield* gatewayServer;

        const service = yield* Effect.gen(function* () {
          const sockets: Array<NodeNet.Socket> = [];
          const dev = yield* listenLoopback((socket) => {
            sockets.push(socket);
            socket.on("error", () => {});
            socket.pipe(socket);
          });
          return { sockets, port: dev.port };
        });

        // A chain of three rows for a device: the first, and two renewals of the same DPoP key.
        const chain = Effect.fn("chain")(function* (device: { readonly id: string }, key: string) {
          const rows = [];
          for (let i = 0; i < 3; i++) {
            rows.push(
              yield* sessions.issue({
                subject: `t3x-device:computer:${device.id}`,
                method: "dpop-access-token",
                scopes: GATEWAY_SCOPES,
                proofKeyThumbprint: key,
                ttl: Duration.hours(1),
                client: { label: "device", deviceType: "desktop" },
              }),
            );
          }
          return rows;
        });
        const laptopRows = yield* chain(laptop, "l".repeat(43));
        const tabletRows = yield* chain(tablet, "t".repeat(43));

        const open = Effect.fn("open")(function* (
          row: { readonly sessionId: SessionStore.VerifiedSession["sessionId"] },
          key: string,
        ) {
          const issued = yield* sessions.issueWebSocketToken(row.sessionId, {
            audience: "loopback-gateway",
            proofKeyThumbprint: key,
          });
          const attempt = yield* openTunnel(port, {
            ticket: issued.token,
            query: `port=${service.port}`,
          });
          if (attempt._tag !== "open") return yield* Effect.die(`refused with ${attempt.status}`);
          // Whatever the test ends with, no tunnel outlives it to hold the server open.
          yield* Effect.addFinalizer(() => Effect.sync(() => attempt.ws.terminate()));
          return attempt.ws;
        });
        // Tickets from the first and from the last row of the laptop's chain, and one for the tablet.
        const laptopTunnels = [
          yield* open(laptopRows[0]!, "l".repeat(43)),
          yield* open(laptopRows[2]!, "l".repeat(43)),
        ];
        const tabletTunnel = yield* open(tabletRows[0]!, "t".repeat(43));
        assert.equal(service.sockets.length, 3);

        const laptopSockets = service.sockets.slice(0, 2);
        const waits = [...laptopTunnels.map(closed), ...laptopSockets.map(closed)];
        // The registry no longer lists the laptop; the next sync is the real reconcile.
        fake.removeDevice(laptop.id);
        yield* directory.sync;
        // Every active row of the chain is gone before anything is waited for.
        const active = yield* sessions.listActive();
        const subjects = active.map((row) => row.subject);
        assert.isFalse(subjects.includes(`t3x-device:computer:${laptop.id}`));
        yield* Effect.all(waits, { concurrency: "unbounded" });
        assert.equal(
          subjects.filter((subject) => subject === `t3x-device:computer:${tablet.id}`).length,
          3,
        );
        // The other device's tunnel is untouched and still carries bytes.
        assert.equal(tabletTunnel.readyState, tabletTunnel.OPEN);
        const reply = Effect.promise(
          () =>
            new Promise<string>((resolve) =>
              tabletTunnel.once("message", (data: Buffer) => resolve(data.toString())),
            ),
        );
        tabletTunnel.send(Buffer.from("still here"));
        assert.equal(yield* reply, "still here");
        tabletTunnel.terminate();
      }).pipe(Effect.provide(layerHarness), Effect.scoped),
  );
});
