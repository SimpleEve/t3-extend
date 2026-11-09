// The device list: persistence, staleness, reconcile, self-removal and the change stream.
import { generateDeviceKey } from "@t3tools/shared/forkDeviceKeys/jws";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";
import * as RegistryClient from "./RegistryClient.ts";
import {
  Harness,
  NOW_MS,
  NOW_S,
  joinThisComputer,
  layerHarness,
  layerMemoryWith,
} from "./deviceHarness.testkit.ts";
import { FakeRegistry, layerFakeRegistry } from "./registryFake.testkit.ts";

const arrange = Effect.gen(function* () {
  yield* TestClock.setTime(NOW_MS);
  const fake = yield* FakeRegistry;
  const directory = yield* DeviceDirectory.DeviceDirectory;
  const service = yield* DeviceKeysService.DeviceKeysService;
  const sessions = yield* SessionStore.SessionStore;
  yield* joinThisComputer();
  const phone = fake.addDevice({ kind: "phone", name: "Pixel" });
  const laptop = fake.addDevice({ kind: "computer", name: "Laptop", environmentId: "env-laptop" });
  yield* directory.sync;
  const sessionFor = (device: { readonly id: string }, kind: "phone" | "computer") =>
    sessions.issue({
      subject: `t3x-device:${kind}:${device.id}`,
      method: "dpop-access-token",
      proofKeyThumbprint: "k".repeat(43),
      ttl: Duration.hours(1),
    });
  // Sessions the server itself starts with are not what these tests are about.
  const baseline = new Set((yield* sessions.listActive()).map((row) => row.subject));
  const live = sessions
    .listActive()
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => row.subject).filter((subject) => !baseline.has(subject)),
      ),
    );
  return { fake, directory, service, sessions, phone, laptop, sessionFor, live };
});

describe("sync and persistence", () => {
  it.effect("stores the list, re-reads an unchanged one, and survives a restart", () =>
    Effect.gen(function* () {
      const { directory, phone } = yield* arrange;
      const first = yield* directory.state;
      assert.equal(first.staleness, "fresh");
      assert.deepEqual(
        Option.getOrThrow(first.list)
          .devices.map((device) => device.name)
          .sort(),
        ["Laptop", "Pixel", "Studio"],
      );
      assert.equal(Option.getOrThrow(first.list).fetchedAt, NOW_S);

      yield* TestClock.adjust(Duration.seconds(100));
      yield* directory.sync;
      const unchanged = Option.getOrThrow((yield* directory.state).list);
      assert.equal(unchanged.fetchedAt, NOW_S + 100);
      assert.equal(unchanged.rev, Option.getOrThrow(first.list).rev);
      assert.deepEqual(unchanged.devices, Option.getOrThrow(first.list).devices);

      // A restarted server reads the same membership and list from disk.
      const restarted = yield* Layer.build(DeviceDirectory.layer);
      const reloaded = yield* Effect.provide(
        DeviceDirectory.DeviceDirectory.pipe(Effect.flatMap((d) => d.state)),
        restarted,
      );
      assert.equal(Option.getOrThrow(reloaded.list).rev, unchanged.rev);
      assert.equal(
        Option.getOrThrow(reloaded.membership).deviceId,
        Option.getOrThrow((yield* directory.state).membership).deviceId,
      );
      assert.isTrue(
        Option.getOrThrow(reloaded.list).devices.some((device) => device.id === phone.id),
      );
    }).pipe(Effect.provide(layerHarness), Effect.scoped),
  );

  it.effect("takes the current body even when rev did not change", () =>
    Effect.gen(function* () {
      const { fake, directory, laptop } = yield* arrange;
      const onlineOf = Effect.map(
        directory.state,
        (state) =>
          Option.getOrThrow(state.list).devices.find((device) => device.id === laptop.id)?.online,
      );
      assert.isUndefined(yield* onlineOf);
      // Online and the sync times move with the clock, not with rev.
      const rev = fake.state.rev;
      fake.state.devices = fake.state.devices.map((device) =>
        device.id === laptop.id ? { ...device, online: true, lastSeenAt: NOW_S + 50 } : device,
      );
      yield* directory.sync;
      assert.equal(fake.state.rev, rev);
      assert.isTrue(yield* onlineOf);
      const seen = Option.getOrThrow((yield* directory.state).list).devices.find(
        (device) => device.id === laptop.id,
      );
      assert.equal(seen?.lastSeenAt, NOW_S + 50);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("keeps the last list, and its age, when the registry cannot be reached", () =>
    Effect.gen(function* () {
      const { fake, directory } = yield* arrange;
      const identity = yield* DeviceIdentity.DeviceIdentity;
      const key = Option.getOrThrow(yield* identity.peek);
      yield* TestClock.adjust(Duration.hours(1));
      // Unreachable, a server error, and an answer from the wrong registry or a redirect: none is "removed".
      const failures = [
        () => {
          fake.state.reachable = false;
        },
        () => {
          fake.state.reachable = true;
          fake.state.rejectWith = "internal";
        },
        () => {
          fake.state.rejectWith = undefined;
          fake.state.failWith = new RegistryClient.RegistryClientError({
            kind: "protocol",
            code: "registry_mismatch",
          });
        },
        () => {
          fake.state.failWith = new RegistryClient.RegistryClientError({
            kind: "protocol",
            status: 307,
            code: "redirect",
          });
        },
      ];
      for (const fail of failures) {
        fail();
        const status = yield* directory.sync;
        assert.equal(status.state, "joined");
        assert.equal(status.fetchedAt, NOW_S);
        assert.equal(Option.getOrThrow((yield* directory.state).list).devices.length, 3);
        assert.equal(Option.getOrThrow(yield* identity.peek).id, key.id);
      }
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "ages the list: fresh to 24 hours, warn to 7 days, then expired until a sync succeeds",
    () =>
      Effect.gen(function* () {
        const { fake, directory } = yield* arrange;
        fake.state.reachable = false;
        const staleness = directory.state.pipe(Effect.map((state) => state.staleness));
        yield* TestClock.adjust(Duration.hours(24));
        assert.equal(yield* staleness, "fresh");
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(yield* staleness, "warn");
        // Exactly seven days after the sync is still usable; one second later it is not.
        yield* TestClock.adjust(Duration.seconds(6 * 24 * 60 * 60 - 1));
        assert.equal(yield* staleness, "warn");
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(yield* staleness, "expired");
        assert.equal((yield* directory.status).staleness, "expired");
        fake.state.reachable = true;
        yield* directory.sync;
        assert.equal(yield* staleness, "fresh");
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("treats a clock that went back past the last sync as stale", () =>
    Effect.gen(function* () {
      const { directory } = yield* arrange;
      yield* TestClock.setTime(NOW_MS - 10_000);
      assert.equal((yield* directory.state).staleness, "warn");
      // Going back to just after the sync is not detected (design 10 #3, accepted).
      yield* TestClock.setTime(NOW_MS + 10_000);
      assert.equal((yield* directory.state).staleness, "fresh");
    }).pipe(Effect.provide(layerHarness)),
  );
});

describe("reconcile", () => {
  it.effect("revokes the sessions of devices that left the list, and nobody else's", () =>
    Effect.gen(function* () {
      const { fake, directory, phone, laptop, sessions, sessionFor, live } = yield* arrange;
      yield* sessionFor(phone, "phone");
      yield* sessionFor(laptop, "computer");
      yield* sessions.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" });
      yield* sessions.issue({ subject: "one-time-token", method: "bearer-access-token" });
      fake.removeDevice(phone.id);
      yield* directory.sync;
      assert.sameMembers(yield* live, [
        `t3x-device:computer:${laptop.id}`,
        "desktop-bootstrap",
        "one-time-token",
      ]);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("reconciles on every sync, so a revoke that failed once is retried", () =>
    Effect.gen(function* () {
      const { fake, directory, phone, sessionFor, live } = yield* arrange;
      fake.removeDevice(phone.id);
      yield* directory.sync;
      // A session for the removed device that slipped in (say, a failed revoke earlier).
      yield* sessionFor(phone, "phone");
      assert.lengthOf(yield* live, 1);
      yield* directory.sync;
      assert.lengthOf(yield* live, 0);
    }).pipe(Effect.provide(layerHarness)),
  );
});

describe("a removal another process made", () => {
  // `devices remove` in a separate CLI process revokes the session rows itself; this server never
  // revokes them, so only its next reconcile can tell a live socket.
  it.effect(
    "closes the open socket of a device when the next sync finds the row already revoked",
    () =>
      Effect.gen(function* () {
        const { fake, directory, phone, laptop, sessions, sessionFor } = yield* arrange;
        const sql = yield* SqlClient.SqlClient;
        const phoneSession = yield* sessionFor(phone, "phone");
        const laptopSession = yield* sessionFor(laptop, "computer");
        const closed = yield* Deferred.make<void>();
        for (const [session, onClose] of [
          [phoneSession, Deferred.succeed(closed, undefined)],
          [laptopSession, Effect.void],
        ] as const) {
          yield* sessions.markConnected(session.sessionId);
          yield* sessions
            .awaitInvalidation(session.sessionId, "k".repeat(43))
            .pipe(Effect.andThen(onClose), Effect.forkScoped({ startImmediately: true }));
        }
        const revokedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
        UPDATE auth_sessions SET revoked_at = ${revokedAt} WHERE session_id = ${phoneSession.sessionId}
      `;
        yield* TestClock.adjust(Duration.seconds(1));
        assert.isFalse(yield* Deferred.isDone(closed));

        fake.removeDevice(phone.id);
        yield* directory.sync;
        yield* TestClock.adjust(Duration.seconds(1));
        assert.isTrue(yield* Deferred.isDone(closed));
        const laptopStillOpen = yield* sessions.verify(laptopSession.token);
        assert.equal(laptopStillOpen.sessionId, laptopSession.sessionId);
      }).pipe(Effect.scoped, Effect.provide(layerHarness)),
  );
});

describe("a leave another process made", () => {
  // `devices leave` in the CLI clears the membership and revokes the device sessions in the
  // database; this server's sync then finds nothing to sync, but must still close the sockets.
  it.effect(
    "closes the open socket of a device when the membership is gone from the next sync",
    () =>
      Effect.gen(function* () {
        const { directory, phone, sessions, sessionFor } = yield* arrange;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const sql = yield* SqlClient.SqlClient;
        const phoneSession = yield* sessionFor(phone, "phone");
        const closed = yield* Deferred.make<void>();
        yield* sessions.markConnected(phoneSession.sessionId);
        yield* sessions
          .awaitInvalidation(phoneSession.sessionId, "k".repeat(43))
          .pipe(
            Effect.andThen(Deferred.succeed(closed, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );
        yield* secrets.remove(DeviceDirectory.MEMBERSHIP_SECRET);
        const revokedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
        UPDATE auth_sessions SET revoked_at = ${revokedAt} WHERE session_id = ${phoneSession.sessionId}
      `;
        yield* TestClock.adjust(Duration.seconds(1));
        assert.isFalse(yield* Deferred.isDone(closed));

        assert.equal((yield* directory.sync).state, "not_joined");
        yield* TestClock.adjust(Duration.seconds(1));
        assert.isTrue(yield* Deferred.isDone(closed));
      }).pipe(Effect.scoped, Effect.provide(layerHarness)),
  );
});

describe("the check for sockets of revoked sessions", () => {
  it.effect("failing does not fail the sync, which still revokes and publishes the list", () =>
    Effect.gen(function* () {
      const { fake, directory, phone, sessionFor, live } = yield* arrange;
      const harness = yield* Harness;
      yield* sessionFor(phone, "phone");
      harness.hooks.beforeAnnounce = Effect.die("the database could not be read");
      fake.removeDevice(phone.id);
      const status = yield* directory.sync;
      assert.equal(status.state, "joined");
      assert.equal(status.fetchedAt, NOW_S);
      assert.lengthOf(yield* live, 0);
    }).pipe(Effect.provide(layerHarness)),
  );
});

describe("this computer leaves the server", () => {
  const assertCleared = Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const identity = yield* DeviceIdentity.DeviceIdentity;
    assert.isTrue(Option.isNone(yield* secrets.get(DeviceDirectory.MEMBERSHIP_SECRET)));
    assert.isTrue(Option.isNone(yield* secrets.get(DeviceDirectory.LIST_SECRET)));
    assert.isTrue(Option.isNone(yield* identity.peek));
  });

  it.effect(
    "clears membership, key, list and device sessions when the registry no longer knows it",
    () =>
      Effect.gen(function* () {
        const { fake, directory, sessions, laptop, sessionFor, live } = yield* arrange;
        yield* sessionFor(laptop, "computer");
        yield* sessions.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" });
        fake.state.forgetCaller = true;
        const status = yield* directory.sync;
        assert.equal(status.state, "removed");
        assert.isNull(status.url);
        assert.equal(status.staleness, "unavailable");
        yield* assertCleared;
        assert.deepEqual(yield* live, ["desktop-bootstrap"]);
        assert.isTrue(Option.isNone(yield* directory.tunnelOrigin));
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("does the same when the list it receives no longer contains it", () =>
    Effect.gen(function* () {
      const { fake, directory } = yield* arrange;
      const self = Option.getOrThrow((yield* directory.state).membership).deviceId;
      fake.removeDevice(self);
      assert.equal((yield* directory.sync).state, "removed");
      yield* assertCleared;
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("can join again afterwards, with a fresh key", () =>
    Effect.gen(function* () {
      const { fake, directory, service } = yield* arrange;
      const first = Option.getOrThrow((yield* directory.state).membership).deviceId;
      fake.state.forgetCaller = true;
      yield* directory.sync;
      fake.state.forgetCaller = false;
      // The old private key went with the membership; the new join signs with a different one.
      const identity = yield* DeviceIdentity.DeviceIdentity;
      assert.isTrue(Option.isNone(yield* identity.peek));
      const status = yield* joinThisComputer("Studio");
      assert.equal(status.state, "joined");
      assert.notEqual(status.deviceId, first);
      assert.equal(Option.getOrThrow(yield* identity.peek).id, status.deviceId);
      assert.equal((yield* service.status).state, "joined");
    }).pipe(Effect.provide(layerHarness)),
  );
});

describe("changes", () => {
  it.effect("streams the current snapshot, then every successful sync", () =>
    Effect.gen(function* () {
      const { fake, directory } = yield* arrange;
      const seen = yield* directory.changes.pipe(
        Stream.take(4),
        Stream.map((snapshot) => ({
          devices: snapshot.devices.length,
          fetchedAt: snapshot.status.fetchedAt,
        })),
        Stream.runCollect,
        Effect.forkChild,
      );
      fake.addDevice({ kind: "phone", name: "Tablet" });
      yield* directory.sync;
      // An unchanged list still moves the sync time, which clients show.
      yield* TestClock.adjust(Duration.seconds(100));
      yield* directory.sync;
      fake.addDevice({ kind: "phone", name: "Watch" });
      yield* directory.sync;
      assert.deepEqual(Array.from(yield* Fiber.join(seen)), [
        { devices: 3, fetchedAt: NOW_S },
        { devices: 4, fetchedAt: NOW_S },
        { devices: 4, fetchedAt: NOW_S + 100 },
        { devices: 5, fetchedAt: NOW_S + 100 },
      ]);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "picks up a membership another process wrote, and only for the same registry's list",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* arrange;
        const other = yield* Layer.build(DeviceDirectory.layer);
        const peer = Option.getOrThrow((yield* directory.state).membership);
        yield* Effect.provide(
          DeviceDirectory.DeviceDirectory.pipe(Effect.flatMap((d) => d.clear("left"))),
          other,
        );
        yield* directory.reload;
        assert.isTrue(Option.isNone((yield* directory.state).membership));
        const state = yield* Effect.provide(
          DeviceDirectory.DeviceDirectory.pipe(
            Effect.tap((d) => d.adopt({ ...peer, deviceId: generateDeviceKey().id })),
            Effect.flatMap((d) => d.state),
          ),
          other,
        );
        assert.isTrue(Option.isNone(state.list));
        yield* directory.reload;
        assert.isTrue(Option.isSome((yield* directory.state).membership));
        assert.isTrue(Option.isNone((yield* directory.state).list));
      }).pipe(Effect.provide(layerHarness), Effect.scoped),
  );
});

// The loop test needs every await to be the TestClock's, so it runs on in-memory storage.
const layerMemory = layerMemoryWith(layerFakeRegistry);

describe("the sync loop", () => {
  it.effect("syncs at once and then every 60 seconds", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fake = yield* FakeRegistry;
      const directory = yield* DeviceDirectory.DeviceDirectory;
      yield* joinThisComputer();
      const calls = () => fake.callsTo("listDevices");
      const before = calls();
      const loop = yield* Effect.forkChild(directory.syncLoop, { startImmediately: true });
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal(calls() - before, 1, "after 1s");
      yield* TestClock.adjust(Duration.seconds(59));
      assert.equal(calls() - before, 2, "after 60s");
      yield* TestClock.adjust(Duration.seconds(59));
      assert.equal(calls() - before, 2, "after 119s");
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal(calls() - before, 3, "after 120s");
      yield* Fiber.interrupt(loop);
    }).pipe(Effect.provide(layerMemory)),
  );
});
