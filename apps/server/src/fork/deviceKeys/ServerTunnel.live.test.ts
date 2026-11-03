// The whole server as shipped (`bin.ts`, the real `server.ts` assembly with `withTunnel`) in a
// subprocess on a temp home: a paired device exchanges a pass on the tunnel listener, opens a
// WebSocket there and makes RPC calls. The membership is seeded on disk the way a join leaves it.
// @effect-diagnostics nodeBuiltinImport:off -- Subprocess and loopback sockets.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { ORCHESTRATION_PROTOCOL_VERSION, WsRpcGroup } from "@t3tools/contracts";
import { signAssertion } from "@t3tools/shared/forkDeviceKeys/assertion";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import { exchangePass, makeDpopSigner, ticketRequest } from "./deviceHarness.testkit.ts";
import { homeDir, seedHome } from "./homeSeed.testkit.ts";
import { FAKE_REGISTRY_ID } from "./registryFake.testkit.ts";

const SERVER_ENTRY = NodePath.resolve(import.meta.dirname, "../../bin.ts");

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

interface RunningServer {
  readonly mainPort: number;
  readonly tunnelPort: number;
}

const startServer = (baseDir: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const mainPort = await freePort();
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          SERVER_ENTRY,
          "--mode",
          "web",
          "--port",
          String(mainPort),
          "--host",
          "127.0.0.1",
          "--base-dir",
          baseDir,
          "--no-browser",
        ],
        { env: { ...process.env, T3CODE_HOME: baseDir }, stdio: ["ignore", "pipe", "pipe"] },
      );
      const output: Array<string> = [];
      const tunnelPort = await new Promise<number>((resolve, reject) => {
        child.once("exit", (code) =>
          reject(new Error(`server exited ${code}:\n${output.join("")}`)),
        );
        const onData = (chunk: unknown) => {
          output.push(String(chunk));
          const joined = output.join("");
          const match = /Tunnel listener on 127\.0\.0\.1:(\d+)/.exec(joined);
          if (match !== null && joined.includes(`Listening on http://127.0.0.1:${mainPort}`)) {
            resolve(Number(match[1]));
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
      });
      return { child, server: { mainPort, tunnelPort } satisfies RunningServer };
    }),
    ({ child }) =>
      Effect.sync(() => {
        child.removeAllListeners("exit");
        child.kill();
      }),
  ).pipe(Effect.map(({ server }) => server));

const makeRpcClient = RpcClient.make(WsRpcGroup);

describe("the real server over the tunnel listener", () => {
  it.live(
    "a paired computer exchanges a pass, opens a WebSocket and calls RPCs; device management stays local",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* homeDir;
        const seeded = yield* seedHome(baseDir);
        const server = yield* startServer(baseDir);

        const signer = makeDpopSigner();
        const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const pass = signAssertion({
          privateKey: seeded.laptop.privateKey,
          deviceId: seeded.laptop.id,
          audienceEnvironmentId: seeded.environmentId,
          registryId: FAKE_REGISTRY_ID,
          dpopThumbprint: signer.thumbprint,
          iat,
          lifetimeSeconds: 60,
        }).assertion;

        // The main listener derives its own origin, so a proof made for the tunnel origin is refused there.
        const refused = yield* exchangePass({
          port: server.mainPort,
          origin: seeded.tunnelOrigin,
          assertion: pass,
          dpop: signer,
        });
        assert.equal(refused.status, 401);

        const exchanged = yield* exchangePass({
          port: server.tunnelPort,
          origin: seeded.tunnelOrigin,
          assertion: pass,
          dpop: signer,
        });
        assert.equal(exchanged.status, 200);
        const token = (exchanged.json() as { access_token: string }).access_token;

        const ticketResponse = yield* ticketRequest({
          port: server.tunnelPort,
          origin: seeded.tunnelOrigin,
          token,
          dpop: signer,
        });
        assert.equal(ticketResponse.status, 200);
        const ticket = (ticketResponse.json() as { ticket: string }).ticket;
        const upgradeProof = yield* signer.proof({
          method: "GET",
          url: `${seeded.tunnelOrigin}/ws`,
          accessToken: ticket,
        });
        const url =
          `ws://127.0.0.1:${server.tunnelPort}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}` +
          `&wsTicket=${encodeURIComponent(ticket)}&dpop=${encodeURIComponent(upgradeProof)}`;

        const scope = yield* Scope.Scope;
        const protocol = yield* Layer.buildWithScope(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(Socket.layerWebSocket(url, { openTimeout: "30 seconds" })),
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
            Layer.provide(RpcSerialization.layerJson),
          ),
          scope,
        );
        const client = yield* makeRpcClient.pipe(Effect.provide(protocol), Scope.provide(scope));

        // An ordinary RPC works through the tunnel with the device's session.
        assert.deepEqual(yield* client["server.probe"]({}), {});

        // Device management is for the person at this computer, not for a paired device.
        const status = yield* client["devices.status"]({}).pipe(Effect.flip);
        assert.equal((status as { reason?: string }).reason, "not_local_owner");
        const signed = yield* client["devices.signAssertion"]({
          audienceEnvironmentId: "env-laptop",
          dpopThumbprint: signer.thumbprint,
        }).pipe(Effect.flip);
        assert.equal((signed as { reason?: string }).reason, "not_local_owner");

        // A pass is spent by its first use.
        const replay = yield* exchangePass({
          port: server.tunnelPort,
          origin: seeded.tunnelOrigin,
          assertion: pass,
          dpop: signer,
        });
        assert.equal(replay.status, 401);
      }).pipe(Effect.scoped),
  );
});
