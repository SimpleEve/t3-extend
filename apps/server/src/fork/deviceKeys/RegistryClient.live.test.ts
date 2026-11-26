// The computer's side of the protocol against the real registry process: the signing, the Content-Length
// rule, the pinned registry, and what a removal looks like from both ends.
// @effect-diagnostics nodeBuiltinImport:off -- A raw chunked request, which no HTTP client will send.
import * as NodeHttp from "node:http";

import {
  parseAssertion,
  signAssertion,
  verifyAssertionSignature,
} from "@t3tools/shared/forkDeviceKeys/assertion";
import { decodeInvite, redemptionOf } from "@t3tools/shared/forkDeviceKeys/invite";
import { generateDeviceKey } from "@t3tools/shared/forkDeviceKeys/jws";
import { signRequestProof } from "@t3tools/shared/forkDeviceKeys/proof";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";
import { layerMemoryWith } from "./deviceHarness.testkit.ts";
import * as RegistryClient from "./RegistryClient.ts";
import {
  REGISTRY_ORIGIN,
  RegistryProcess,
  layerRegistryHttp,
  layerRegistryProcess,
} from "./registryProcess.testkit.ts";

const layerLive = layerMemoryWith(
  RegistryClient.layer.pipe(
    Layer.provide(layerRegistryHttp),
    Layer.provideMerge(layerRegistryProcess),
  ),
);

/** The same registry process, until a test points the client at a server of its own. */
class Redirect extends Context.Service<Redirect, { port: number | undefined }>()(
  "t3/fork/deviceKeys/RegistryClient.live.test/Redirect",
) {}

const layerRedirectable = Layer.unwrap(
  Effect.sync(() => {
    const redirect: { port: number | undefined } = { port: undefined };
    const process = Layer.effect(
      RegistryProcess,
      Effect.gen(function* () {
        const real = yield* RegistryProcess;
        return {
          sent: real.sent,
          invite: real.invite,
          get port() {
            return redirect.port ?? real.port;
          },
        };
      }),
    ).pipe(Layer.provide(layerRegistryProcess));
    return Layer.merge(
      layerMemoryWith(
        RegistryClient.layer.pipe(Layer.provide(layerRegistryHttp), Layer.provideMerge(process)),
      ),
      Layer.succeed(Redirect, redirect),
    );
  }),
);

const listen = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer(handler);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

const portOf = (server: NodeHttp.Server) => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const start = Effect.gen(function* () {
  return {
    registry: yield* RegistryProcess,
    client: yield* RegistryClient.RegistryClient,
    service: yield* DeviceKeysService.DeviceKeysService,
    directory: yield* DeviceDirectory.DeviceDirectory,
    identity: yield* DeviceIdentity.DeviceIdentity,
  };
});

/** Another device joining the same registry, as the phone or a second computer would. */
const joinOther = Effect.fn("joinOther")(function* (
  invite: string,
  input: {
    readonly name: string;
    readonly kind: "computer" | "phone";
    readonly environmentId: string;
  },
) {
  const client = yield* RegistryClient.RegistryClient;
  const decoded = decodeInvite(invite);
  assert.isNotNull(decoded);
  const key = generateDeviceKey();
  const joined = yield* client.join({
    origin: REGISTRY_ORIGIN,
    invite: redemptionOf(decoded!),
    privateKey: key.privateKey,
    jwk: key.jwk,
    ...input,
  });
  return {
    key,
    joined,
    target: {
      origin: REGISTRY_ORIGIN,
      registryId: joined.registryId,
      deviceId: key.id,
      privateKey: key.privateKey,
    },
  };
});

describe("against the real registry", () => {
  it.live(
    "joins, syncs, invites, renames and removes, sending every body with a Content-Length",
    () =>
      Effect.gen(function* () {
        const { registry, service, directory, identity } = yield* start;
        const status = yield* service.join({ invite: registry.invite("computer"), name: "Studio" });
        assert.equal(status.state, "joined");
        assert.equal(status.url, `https://studio.t3.registry.test`);
        const key = Option.getOrThrow(yield* identity.peek);
        assert.equal(status.deviceId, key.id);

        const second = yield* joinOther(registry.invite("computer"), {
          name: "Laptop",
          kind: "computer",
          environmentId: "env-laptop",
        });
        const phoneInvite = yield* service.invite("phone");
        const phone = yield* joinOther(phoneInvite.invite, {
          name: "Pixel",
          kind: "phone",
          environmentId: "env-phone",
        });
        yield* service.refresh;
        const list = Option.getOrThrow((yield* directory.state).list);
        assert.sameMembers(
          list.devices.map((device) => device.name),
          ["Studio", "Laptop", "Pixel"],
        );
        const rev = list.rev;

        // The key the registry hands back for another computer verifies that computer's pass.
        const listed = list.devices.find((device) => device.id === second.key.id);
        const pass = parseAssertion(
          signAssertion({
            privateKey: second.key.privateKey,
            deviceId: second.key.id,
            audienceEnvironmentId: "env-memory",
            registryId: list.registryId,
            dpopThumbprint: "j".repeat(43),
            iat: Math.floor((yield* Clock.currentTimeMillis) / 1000),
            lifetimeSeconds: 60,
          }).assertion,
        );
        assert.isTrue(verifyAssertionSignature(pass, listed!.jwk));

        // Nothing changed: the registry still answers with the whole list, and the client never asks for a 304.
        yield* service.refresh;
        const again = Option.getOrThrow((yield* directory.state).list);
        assert.equal(again.rev, rev);
        assert.sameMembers(
          again.devices.map((device) => device.name),
          ["Studio", "Laptop", "Pixel"],
        );
        assert.isFalse(registry.sent.some((request) => request.conditional));

        assert.deepEqual(yield* service.rename(phone.key.id, "Pixel 9"), {
          id: phone.key.id,
          name: "Pixel 9",
        });
        const removal = yield* service.remove(phone.key.id);
        assert.deepEqual(removal.pendingComputers, [{ id: second.key.id, name: "Laptop" }]);
        assert.isFalse(
          Option.getOrThrow((yield* directory.state).list).devices.some(
            (device) => device.id === phone.key.id,
          ),
        );

        const bodied = registry.sent.filter((request) => request.bodyBytes > 0);
        assert.isAbove(bodied.length, 2);
        for (const request of bodied) {
          assert.equal(request.bodyTag, "Uint8Array", request.path);
          assert.equal(request.contentLength, request.bodyBytes, request.path);
        }
        assert.lengthOf(
          registry.sent.filter(
            (request) => request.path === "/v1/join" && request.method === "POST",
          ),
          3,
        );
      }).pipe(Effect.provide(layerLive)),
  );

  it.live(
    "learns it was removed from the list, and from the registry saying it no longer knows it",
    () =>
      Effect.gen(function* () {
        const { registry, client, service, directory, identity } = yield* start;
        yield* service.join({ invite: registry.invite("computer"), name: "Studio" });
        const self = Option.getOrThrow(yield* identity.peek);
        const second = yield* joinOther(registry.invite("computer"), {
          name: "Laptop",
          kind: "computer",
          environmentId: "env-laptop",
        });
        yield* service.refresh;

        yield* client.removeDevice(second.target, self.id);
        const status = yield* directory.sync;
        assert.equal(status.state, "removed");
        assert.isTrue(Option.isNone(yield* identity.peek));
        assert.isTrue(Option.isNone((yield* directory.state).membership));
      }).pipe(Effect.provide(layerLive)),
  );

  it.live(
    "hides this computer from the devices it chose, who still see it as an identity only, and never as removed",
    () =>
      Effect.gen(function* () {
        const { registry, client, service, directory, identity } = yield* start;
        yield* service.join({ invite: registry.invite("computer"), name: "Studio" });
        const self = Option.getOrThrow(yield* identity.peek);
        const laptop = yield* joinOther(registry.invite("computer"), {
          name: "Laptop",
          kind: "computer",
          environmentId: "env-laptop",
        });
        const phone = yield* joinOther(registry.invite("phone"), {
          name: "Pixel",
          kind: "phone",
          environmentId: "env-phone",
        });
        const status = yield* service.setVisibility({
          mode: "hidden_from_selected",
          deviceIds: [laptop.key.id],
        });
        assert.equal(status.visibility?.registry, "synced");

        // The next sync reads back what the registry now holds for this computer.
        yield* service.refresh;
        const own = Option.getOrThrow((yield* directory.state).list).devices.find(
          (device) => device.id === self.id,
        );
        assert.deepEqual(own?.visibility, {
          mode: "hidden_from_selected",
          deviceIds: [laptop.key.id],
        });
        const asLaptop = yield* client.listDevices(laptop.target);
        assert.deepEqual(
          asLaptop.devices.map((device) => device.name),
          ["Laptop", "Pixel"],
        );
        assert.deepEqual(
          asLaptop.hiddenPeers?.map((peer) => peer.id),
          [self.id],
        );
        const asPhone = yield* client.listDevices(phone.target);
        assert.sameMembers(
          asPhone.devices.map((device) => device.name),
          ["Studio", "Laptop", "Pixel"],
        );
        assert.isUndefined(asPhone.hiddenPeers);

        // The laptop cannot remove what it cannot see; the registry answers as if there were nothing.
        const refused = yield* client.removeDevice(laptop.target, self.id).pipe(Effect.flip);
        assert.equal(refused.code, "not_found");
        assert.isTrue(
          Option.getOrThrow((yield* directory.state).list).devices.some(
            (device) => device.id === self.id,
          ),
        );

        // Opening it again makes the computer reappear for the laptop.
        yield* service.setVisibility({ mode: "visible_to_all", deviceIds: [] });
        assert.sameMembers(
          (yield* client.listDevices(laptop.target)).devices.map((device) => device.name),
          ["Studio", "Laptop", "Pixel"],
        );
      }).pipe(Effect.provide(layerLive)),
  );

  it.live("leave takes this computer out of the registry's list", () =>
    Effect.gen(function* () {
      const { registry, client, service } = yield* start;
      yield* service.join({ invite: registry.invite("computer"), name: "Studio" });
      const second = yield* joinOther(registry.invite("computer"), {
        name: "Laptop",
        kind: "computer",
        environmentId: "env-laptop",
      });
      assert.equal((yield* service.leave).state, "not_joined");
      const remaining = yield* client.listDevices(second.target);
      assert.deepEqual(
        remaining.devices.map((device) => device.name),
        ["Laptop"],
      );
    }).pipe(Effect.provide(layerLive)),
  );

  it.live("refuses a registry other than the one pinned, and an invite that was already used", () =>
    Effect.gen(function* () {
      const { registry, client, service } = yield* start;
      const invite = registry.invite("computer");
      yield* service.join({ invite, name: "Studio" });
      const again = yield* joinOther(invite, {
        name: "Laptop",
        kind: "computer",
        environmentId: "env-laptop",
      }).pipe(Effect.flip);
      assert.equal(again.code, "invite_used");

      const info = yield* client.info(REGISTRY_ORIGIN);
      const joined = yield* joinOther(registry.invite("computer"), {
        name: "Laptop",
        kind: "computer",
        environmentId: "env-laptop",
      });
      const wrongPin = yield* client
        .listDevices({ ...joined.target, registryId: `${info.registryId}x` })
        .pipe(Effect.flip);
      assert.deepEqual([wrongPin.kind, wrongPin.code], ["protocol", "registry_mismatch"]);
    }).pipe(Effect.provide(layerLive)),
  );

  it.live(
    "the registry itself refuses a signed upload sent chunked, and accepts the same one with a length",
    () =>
      Effect.gen(function* () {
        const { registry, service, identity } = yield* start;
        yield* service.join({ invite: registry.invite("computer"), name: "Studio" });
        const key = Option.getOrThrow(yield* identity.peek);
        const body = new TextEncoder().encode(JSON.stringify({ kind: "phone" }));
        const post = Effect.fn("post")(function* (chunked: boolean) {
          const proof = signRequestProof({
            privateKey: key.privateKey,
            kid: key.id,
            method: "POST",
            htu: `${REGISTRY_ORIGIN}/v1/invites`,
            iat: Math.floor((yield* Clock.currentTimeMillis) / 1000),
            body,
          });
          return yield* Effect.promise(
            () =>
              new Promise<number>((resolve, reject) => {
                const req = NodeHttp.request(
                  {
                    host: "127.0.0.1",
                    port: registry.port,
                    method: "POST",
                    path: "/v1/invites",
                    headers: {
                      "t3x-proof": proof,
                      "content-type": "application/json",
                      ...(chunked ? {} : { "content-length": String(body.length) }),
                    },
                  },
                  (res) => {
                    res.resume();
                    res.on("end", () => resolve(res.statusCode ?? 0));
                  },
                );
                req.on("error", reject);
                if (chunked) {
                  req.write(body.subarray(0, 4));
                  req.write(body.subarray(4));
                }
                req.end(chunked ? undefined : body);
              }),
          );
        });
        assert.equal(yield* post(true), 400);
        assert.equal(yield* post(false), 201);
      }).pipe(Effect.provide(layerLive)),
  );

  it.live("never follows a redirect from the registry, whatever it answers", () =>
    Effect.gen(function* () {
      const { registry, client, service, directory, identity } = yield* start;
      const redirect = yield* Redirect;
      yield* service.join({ invite: registry.invite("computer"), name: "Studio" });
      const key = Option.getOrThrow(yield* identity.peek);
      const before = yield* directory.state;
      const target = {
        origin: REGISTRY_ORIGIN,
        registryId: Option.getOrThrow(before.membership).registryId,
        deviceId: key.id,
        privateKey: key.privateKey,
      };

      const elsewhere: Array<string> = [];
      const other = yield* listen((req, res) => {
        elsewhere.push(`${req.method} ${req.url} proof=${req.headers["t3x-proof"] !== undefined}`);
        res.statusCode = 404;
        res.end();
      });
      let status = 301;
      // The body says "unknown device", which would wipe this computer if a redirect counted as an answer.
      const registryStandIn = yield* listen((_req, res) => {
        res.statusCode = status;
        res.setHeader("location", `http://127.0.0.1:${portOf(other)}/elsewhere`);
        res.setHeader("content-type", "application/json");
        res.end('{"error":"device_unknown"}');
      });
      redirect.port = portOf(registryStandIn);

      for (status of [301, 304, 307]) {
        const calls = {
          info: yield* client.info(REGISTRY_ORIGIN).pipe(Effect.flip),
          list: yield* client.listDevices(target).pipe(Effect.flip),
          invite: yield* client.createInvite(target, "phone").pipe(Effect.flip),
        };
        for (const error of Object.values(calls)) {
          assert.deepEqual(
            [error.kind, error.status, error.code],
            ["protocol", status, "redirect"],
          );
        }
        assert.equal(
          (yield* service.invite("phone").pipe(Effect.flip)).reason,
          "registry_rejected",
        );
        const synced = yield* directory.sync;
        assert.equal(synced.state, "joined");
      }

      assert.deepEqual(elsewhere, []);
      const after = yield* directory.state;
      assert.deepEqual(after.membership, before.membership);
      assert.deepEqual(after.list, before.list);
      assert.equal(Option.getOrThrow(yield* identity.peek).id, key.id);
    }).pipe(Effect.provide(layerRedirectable), Effect.scoped),
  );
});
