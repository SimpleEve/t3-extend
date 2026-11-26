import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  BearerConnectionProfile,
  connectionRegistrationCatalogEntry,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  type ConnectionRegistration,
} from "../../connection/catalog.ts";
import * as ConnectionCredentialStore from "../../connection/credentialStore.ts";
import { BearerConnectionTarget } from "../../connection/model.ts";
import * as EnvironmentRegistry from "../../connection/registry.ts";
import * as RpcHttp from "../../rpc/http.ts";
import {
  DeviceEnvironmentIndex,
  DeviceKeyAuthorization,
  blockedDeviceKeyAuthorization,
  deviceConnectionId,
  makeDeviceEnvironmentIndex,
  refuseRelayForDeviceEnvironment,
} from "./DeviceKeyAuthorization.ts";
import {
  layerDeviceEnvironmentSync,
  managedDeviceEnvironments,
  reconcileDeviceEnvironments,
} from "./deviceEnvironmentSync.ts";
import { computer, descriptorJson, deviceEntry, view } from "./deviceAuthorization.testkit.ts";

const env = (id: string) => EnvironmentId.make(id);

const userEnvironment = (): ConnectionCatalogEntry => {
  const target = new BearerConnectionTarget({
    environmentId: env("environment-by-hand"),
    label: "By hand",
    connectionId: "by-hand",
  });
  return {
    target,
    enabled: true,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: "by-hand",
        environmentId: env("environment-by-hand"),
        label: "By hand",
        httpBaseUrl: "https://hand.example.test/",
        wsBaseUrl: "wss://hand.example.test/",
      }),
    ),
  };
};

const makeRig = Effect.fn("DeviceSyncRig.make")(function* (options?: {
  readonly probe?: (url: string) => string;
}) {
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[env("environment-by-hand"), userEnvironment()]]),
  );
  const credentials = new Map<string, ConnectionCredential>();
  const removed = yield* Ref.make<ReadonlyArray<string>>([]);
  const forgotten = yield* Ref.make<ReadonlyArray<string>>([]);
  const registrations = yield* Ref.make<ReadonlyArray<ConnectionRegistration>>([]);
  const probes: Array<string> = [];
  const index = makeDeviceEnvironmentIndex();
  index.bind(entries);
  // What the index answers at the moment the registry would start connecting a new environment.
  const seenWhenStarting: Array<string | undefined> = [];
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries,
    register: (registration: ConnectionRegistration) =>
      Effect.gen(function* () {
        const entry = connectionRegistrationCatalogEntry(registration);
        if (registration._tag === "BearerConnectionRegistration") {
          credentials.set(registration.target.connectionId, registration.credential);
        }
        yield* Ref.update(registrations, (all) => [...all, registration]);
        yield* SubscriptionRef.update(entries, (current) =>
          new Map(current).set(entry.target.environmentId, entry),
        );
        seenWhenStarting.push(index.get(entry.target.environmentId));
        return true;
      }),
    remove: (environmentId: EnvironmentId) =>
      Ref.update(removed, (all) => [...all, environmentId]).pipe(
        Effect.andThen(
          SubscriptionRef.update(entries, (current) => {
            const next = new Map(current);
            next.delete(environmentId);
            return next;
          }),
        ),
      ),
  } as never);
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (id) => Effect.succeed(Option.fromNullishOr(credentials.get(id))),
    put: (id, credential) => Effect.sync(() => void credentials.set(id, credential)),
    remove: (id) => Effect.sync(() => void credentials.delete(id)),
  });
  const services = Layer.mergeAll(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
    Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
    Layer.succeed(DeviceEnvironmentIndex, index),
    Layer.succeed(DeviceKeyAuthorization, {
      ...blockedDeviceKeyAuthorization,
      forget: (id) => Ref.update(forgotten, (all) => [...all, id]),
    }),
    RpcHttp.layerRemoteHttpClient(async (request) => {
      probes.push(String(request));
      const url = String(request);
      return Response.json(descriptorJson(options?.probe?.(url) ?? "environment-probed"));
    }),
  );
  return {
    services,
    run: (next: ReturnType<typeof view> | null) =>
      reconcileDeviceEnvironments(next).pipe(Effect.provide(services)),
    entries,
    credentials,
    removed,
    forgotten,
    registrations,
    index,
    seenWhenStarting,
    probes,
    managed: Effect.map(SubscriptionRef.get(entries), (all) => managedDeviceEnvironments(all)),
  };
});

describe("device environment sync", () => {
  it.effect("saves the other computers as device environments with no credential", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      yield* rig.run(
        view([
          computer({ deviceId: "me", self: true, environmentId: env("environment-me") }),
          computer({ deviceId: "mac", name: "Mac", environmentId: env("environment-mac") }),
          computer({ deviceId: "bad", url: "http://bad.t3.example.test", environmentId: env("x") }),
          computer({ deviceId: "nourl", url: null, environmentId: env("y") }),
        ]),
      );
      expect(yield* rig.managed).toEqual([
        {
          environmentId: "environment-mac",
          deviceId: "mac",
          url: "https://mac.t3.example.test",
        },
      ]);
      const [registration] = yield* Ref.get(rig.registrations);
      expect(registration).toMatchObject({
        profile: {
          connectionId: deviceConnectionId("mac"),
          authorization: "t3x-device",
          httpBaseUrl: "https://mac.t3.example.test",
          wsBaseUrl: "wss://mac.t3.example.test/",
        },
        target: { label: "Mac" },
      });
      // The registry insists on a credential while registering; none is left behind.
      expect([...rig.credentials.keys()]).toEqual([]);
      expect(rig.index.get("environment-mac")).toBe("mac");
      expect(rig.index.get("environment-me")).toBeUndefined();
    }),
  );

  it.effect("asks a computer for its environment id when the list carries none", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({ probe: () => "environment-from-the-computer" });
      const list = view([computer({ deviceId: "mac", environmentId: null })], false);
      yield* rig.run(list);
      yield* rig.run(list);
      expect((yield* rig.managed).map((entry) => entry.environmentId)).toEqual([
        "environment-from-the-computer",
      ]);
      // Known and unchanged, so it is not asked again.
      expect(rig.probes).toHaveLength(1);
      expect(yield* Ref.get(rig.registrations)).toHaveLength(1);
    }),
  );

  it.effect("waits for a computer the registry has no environment id for", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      yield* rig.run(view([computer({ environmentId: null })]));
      expect(yield* rig.managed).toEqual([]);
      expect(rig.probes).toEqual([]);
    }),
  );

  it.effect("moves a computer to its new address and replaces one that got a new identity", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      yield* rig.run(view([computer({ deviceId: "mac", environmentId: env("environment-mac") })]));
      yield* rig.run(
        view([
          computer({
            deviceId: "mac",
            url: "https://mac-2.t3.example.test",
            environmentId: env("environment-mac"),
          }),
        ]),
      );
      expect((yield* rig.managed).map((entry) => entry.url)).toEqual([
        "https://mac-2.t3.example.test",
      ]);
      expect(yield* Ref.get(rig.removed)).toEqual([]);

      yield* rig.run(view([computer({ deviceId: "mac", environmentId: env("environment-new") })]));
      expect((yield* rig.managed).map((entry) => entry.environmentId)).toEqual(["environment-new"]);
      expect(yield* Ref.get(rig.removed)).toEqual(["environment-mac"]);
      expect(yield* Ref.get(rig.forgotten)).toEqual(["environment-mac"]);
    }),
  );

  it.effect("drops a removed computer's environment and session, and leaves the user's alone", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      yield* rig.run(
        view([
          computer({ deviceId: "mac", environmentId: env("environment-mac") }),
          computer({
            deviceId: "pc",
            environmentId: env("environment-pc"),
            url: "https://pc.t3.example.test",
          }),
        ]),
      );
      yield* rig.run(
        view([
          computer({
            deviceId: "pc",
            environmentId: env("environment-pc"),
            url: "https://pc.t3.example.test",
          }),
        ]),
      );
      expect((yield* rig.managed).map((entry) => entry.deviceId)).toEqual(["pc"]);
      expect(yield* Ref.get(rig.removed)).toEqual(["environment-mac"]);
      expect(yield* Ref.get(rig.forgotten)).toEqual(["environment-mac"]);
      expect(rig.index.get("environment-mac")).toBeUndefined();
      expect(yield* SubscriptionRef.get(rig.entries)).toHaveProperty("size", 2);
      expect((yield* SubscriptionRef.get(rig.entries)).has(env("environment-by-hand"))).toBe(true);
    }),
  );

  it.effect(
    "treats a computer that hid from this device as removed, and finds it again when it is shown",
    () =>
      Effect.gen(function* () {
        const rig = yield* makeRig();
        const me = computer({ deviceId: "me", self: true, environmentId: env("environment-me") });
        const mac = computer({ deviceId: "mac", environmentId: env("environment-mac") });
        yield* rig.run(view([me, mac]));
        // The server's list for this device no longer carries the computer; this device is still in it.
        yield* rig.run(view([me]));
        expect(yield* rig.managed).toEqual([]);
        expect(yield* Ref.get(rig.removed)).toEqual(["environment-mac"]);
        expect(yield* Ref.get(rig.forgotten)).toEqual(["environment-mac"]);
        expect(rig.index.get("environment-mac")).toBeUndefined();
        expect((yield* SubscriptionRef.get(rig.entries)).has(env("environment-by-hand"))).toBe(
          true,
        );
        // Shown again: the next sync registers it and a connection can start on its own.
        yield* rig.run(view([me, mac]));
        expect((yield* rig.managed).map((entry) => entry.deviceId)).toEqual(["mac"]);
        expect(rig.index.get("environment-mac")).toBe("mac");
      }),
  );

  it.effect("keeps a listed computer whose address is missing for now", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      yield* rig.run(view([computer({ deviceId: "mac", environmentId: env("environment-mac") })]));
      yield* rig.run(
        view([computer({ deviceId: "mac", url: null, environmentId: env("environment-mac") })]),
      );
      expect((yield* rig.managed).map((entry) => entry.deviceId)).toEqual(["mac"]);
      expect(yield* Ref.get(rig.removed)).toEqual([]);
    }),
  );

  it.effect("removes every device environment when this device leaves the server", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      yield* rig.run(view([computer({ deviceId: "mac", environmentId: env("environment-mac") })]));
      yield* rig.run(null);
      expect(yield* rig.managed).toEqual([]);
      expect(yield* Ref.get(rig.removed)).toEqual(["environment-mac"]);
      expect((yield* SubscriptionRef.get(rig.entries)).has(env("environment-by-hand"))).toBe(true);
    }),
  );

  it.effect("a new computer is already found when the registry starts connecting it", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      yield* rig.run(view([computer({ deviceId: "mac", environmentId: env("environment-mac") })]));
      expect(rig.seenWhenStarting).toEqual(["mac"]);
    }),
  );

  it.effect("finds a restored device environment before any sync ran, and refuses it a relay", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      yield* SubscriptionRef.update(rig.entries, (current) =>
        new Map(current).set(env("environment-mac"), deviceEntry("mac", "environment-mac")),
      );
      expect(rig.index.get("environment-mac")).toBe("mac");
      const refused = yield* refuseRelayForDeviceEnvironment("environment-mac").pipe(
        Effect.provideService(DeviceEnvironmentIndex, rig.index),
        Effect.flip,
      );
      expect(refused).toMatchObject({ _tag: "ConnectionBlockedError", hop: "device" });
    }),
  );

  it.effect("only environments with the device profile are managed", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      // A saved environment of the user's own, and one that merely borrows the id scheme.
      expect(rig.index.get("environment-by-hand")).toBeUndefined();
      const lookalike = deviceEntry("mac", "environment-mac", { learned: true });
      yield* SubscriptionRef.update(rig.entries, (current) =>
        new Map(current).set(env("environment-mac"), lookalike),
      );
      expect(rig.index.get("environment-mac")).toBeUndefined();
      yield* refuseRelayForDeviceEnvironment("environment-by-hand").pipe(
        Effect.provideService(DeviceEnvironmentIndex, rig.index),
      );
    }),
  );

  it.effect(
    "recognises the devices of every registry bound to it, and drops one once unbound",
    () =>
      Effect.gen(function* () {
        const directoryOf = (deviceId: string, environmentId: string) =>
          SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map([[env(environmentId), deviceEntry(deviceId, environmentId)]]),
          );
        const index = makeDeviceEnvironmentIndex();
        const unbindFirst = index.bind(yield* directoryOf("a", "environment-a"));
        index.bind(yield* directoryOf("b", "environment-b"));
        expect(index.get("environment-a")).toBe("a");
        expect(index.get("environment-b")).toBe("b");
        unbindFirst();
        expect(index.get("environment-a")).toBeUndefined();
        expect(index.get("environment-b")).toBe("b");
      }),
  );

  it.effect("fails closed until a directory is bound, when asked to", () =>
    Effect.gen(function* () {
      const index = makeDeviceEnvironmentIndex({ failClosedUntilBound: true });
      const refuse = (environmentId: string) =>
        refuseRelayForDeviceEnvironment(environmentId).pipe(
          Effect.provideService(DeviceEnvironmentIndex, index),
        );
      // Before any directory is bound nothing can be told apart, so every environment is refused.
      for (const id of ["environment-mac", "environment-by-hand"]) {
        expect(yield* refuse(id).pipe(Effect.flip)).toMatchObject({
          _tag: "ConnectionTransientError",
          hop: "device",
        });
      }
      const unbind = index.bind(
        yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map([
            [env("environment-by-hand"), userEnvironment()],
            [env("environment-mac"), deviceEntry("mac", "environment-mac")],
          ]),
        ),
      );
      yield* refuse("environment-by-hand");
      expect(yield* refuse("environment-mac").pipe(Effect.flip)).toMatchObject({
        _tag: "ConnectionBlockedError",
        hop: "device",
      });
      // Nothing bound any more: closed again, not open.
      unbind();
      expect((yield* refuse("environment-by-hand").pipe(Effect.flip))._tag).toBe(
        "ConnectionTransientError",
      );
      // The default index stays as it was for runtimes without the device feature.
      yield* refuseRelayForDeviceEnvironment("environment-mac").pipe(
        Effect.provideService(DeviceEnvironmentIndex, makeDeviceEnvironmentIndex()),
      );
    }),
  );

  it.effect("leaves an unchanged list alone: nothing registered, removed or reconnected", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      const list = view([computer({ deviceId: "mac", environmentId: env("environment-mac") })]);
      yield* rig.run(list);
      yield* rig.run(list);
      yield* rig.run(list);
      expect(yield* Ref.get(rig.registrations)).toHaveLength(1);
      expect(yield* Ref.get(rig.removed)).toEqual([]);
      expect(yield* Ref.get(rig.forgotten)).toEqual([]);
    }),
  );

  it.effect("applies each view a platform feeds in, one after another", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      const mac = computer({ deviceId: "mac", environmentId: env("environment-mac") });
      const done = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            layerDeviceEnvironmentSync(
              Stream.fromIterable([view([mac]), view([mac]), null]).pipe(
                Stream.onEnd(Deferred.succeed(done, undefined)),
              ),
            ).pipe(Layer.provide(rig.services)),
          );
          // The stream ends only after the device left and its environment was removed.
          yield* Deferred.await(done);
        }),
      );
      expect(yield* rig.managed).toEqual([]);
      expect(yield* Ref.get(rig.removed)).toEqual(["environment-mac"]);
    }),
  );
});
