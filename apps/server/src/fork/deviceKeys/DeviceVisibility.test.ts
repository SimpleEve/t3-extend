// A computer's own choice of who may see it and sign in to it: saved on this computer, enforced when
// a pass is judged, applied to open sessions at once, and only reported to the registry.
import type { DeviceVisibility } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";
import * as RegistryClient from "./RegistryClient.ts";
import {
  type DpopSigner,
  Harness,
  NOW_MS,
  exchangePass,
  joinThisComputer,
  layerHarness,
  makeDpopSigner,
  passFor,
} from "./deviceHarness.testkit.ts";
import { FakeRegistry } from "./registryFake.testkit.ts";

const arrange = Effect.gen(function* () {
  yield* TestClock.setTime(NOW_MS);
  const harness = yield* Harness;
  const fake = yield* FakeRegistry;
  const directory = yield* DeviceDirectory.DeviceDirectory;
  const service = yield* DeviceKeysService.DeviceKeysService;
  const sessions = yield* SessionStore.SessionStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* joinThisComputer();
  const phone = fake.addDevice({ kind: "phone", name: "Pixel" });
  const laptop = fake.addDevice({ kind: "computer", name: "Laptop", environmentId: "env-laptop" });
  yield* service.refresh;

  const sessionFor = (device: { readonly id: string }, kind: "phone" | "computer") =>
    sessions.issue({
      subject: `t3x-device:${kind}:${device.id}`,
      method: "dpop-access-token",
      proofKeyThumbprint: "k".repeat(43),
      ttl: Duration.hours(1),
    });
  const baseline = new Set((yield* sessions.listActive()).map((row) => row.subject));
  const live = sessions
    .listActive()
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => row.subject).filter((subject) => !baseline.has(subject)),
      ),
    );
  const exchange = Effect.fn("exchange")(function* (
    who: { readonly privateKey: Uint8Array; readonly id: string },
    dpop: DpopSigner = makeDpopSigner(),
  ) {
    const assertion = yield* passFor(who, { audience: harness.environmentId, dpop });
    return yield* exchangePass({ port: harness.port, origin: harness.origin, assertion, dpop });
  });
  const reason = (response: { headers: Readonly<Record<string, unknown>> }) =>
    response.headers["t3x-reason"];
  const set = (visibility: DeviceVisibility) => service.setVisibility(visibility);
  return {
    harness,
    fake,
    directory,
    service,
    sessions,
    secrets,
    phone,
    laptop,
    sessionFor,
    live,
    exchange,
    reason,
    set,
  };
});

const subjectsOf = (ids: ReadonlyArray<{ readonly id: string }>, kind: "phone" | "computer") =>
  ids.map((device) => `t3x-device:${kind}:${device.id}`);

describe("saving the setting", () => {
  it.effect("starts visible to everyone and reports it in the status", () =>
    Effect.gen(function* () {
      const { directory } = yield* arrange;
      assert.deepEqual((yield* directory.status).visibility, {
        mode: "visible_to_all",
        deviceIds: [],
        registry: "synced",
      });
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("keeps the choice in this computer's own file and reads it back after a restart", () =>
    Effect.gen(function* () {
      const { set, phone, secrets, directory } = yield* arrange;
      const status = yield* set({ mode: "hidden_from_selected", deviceIds: [phone.id, phone.id] });
      assert.equal(status.visibility?.mode, "hidden_from_selected");
      assert.deepEqual(status.visibility?.deviceIds, [phone.id]);
      assert.isTrue(Option.isSome(yield* secrets.get(DeviceDirectory.VISIBILITY_SECRET)));
      assert.deepEqual(yield* directory.visibility, {
        mode: "hidden_from_selected",
        deviceIds: [phone.id],
      });
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("refuses this computer's own id, ids that are not device ids, and too many", () =>
    Effect.gen(function* () {
      const { set, directory } = yield* arrange;
      const self = Option.getOrThrow((yield* directory.state).membership).deviceId;
      const refusals = [
        { mode: "hidden_from_selected", deviceIds: [self] },
        { mode: "hidden_from_selected", deviceIds: ["short"] },
        {
          mode: "hidden_from_selected",
          deviceIds: Array.from({ length: 65 }, (_, i) => String(i).padStart(43, "a")),
        },
      ] as const;
      for (const refusal of refusals) {
        const error = yield* set(refusal).pipe(Effect.flip);
        assert.equal(error.reason, "invalid_input");
      }
      assert.equal((yield* directory.visibility).mode, "visible_to_all");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("needs a membership", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const service = yield* DeviceKeysService.DeviceKeysService;
      const error = yield* service
        .setVisibility({ mode: "hidden_from_all", deviceIds: [] })
        .pipe(Effect.flip);
      assert.equal(error.reason, "not_joined");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("goes back to visible to everyone when this computer leaves and joins again", () =>
    Effect.gen(function* () {
      const { set, service, secrets, directory } = yield* arrange;
      yield* set({ mode: "hidden_from_all", deviceIds: [] });
      yield* service.leave;
      assert.isTrue(Option.isNone(yield* secrets.get(DeviceDirectory.VISIBILITY_SECRET)));
      assert.equal((yield* directory.visibility).mode, "visible_to_all");
      yield* joinThisComputer();
      assert.equal((yield* directory.status).visibility?.mode, "visible_to_all");
    }).pipe(Effect.provide(layerHarness)),
  );
});

describe("turning hiding on", () => {
  const modes = [
    {
      name: "hidden from everyone",
      visibility: () => ({ mode: "hidden_from_all", deviceIds: [] }) as const,
      revokes: ["phone", "laptop"],
    },
    {
      name: "hidden from the phone",
      visibility: (ids: { phone: string }) =>
        ({ mode: "hidden_from_selected", deviceIds: [ids.phone] }) as const,
      revokes: ["phone"],
    },
    {
      name: "visible only to the phone",
      visibility: (ids: { phone: string }) =>
        ({ mode: "visible_to_selected", deviceIds: [ids.phone] }) as const,
      revokes: ["laptop"],
    },
  ];
  it.effect.each(modes)("$name: revokes exactly the sessions it excludes", (mode) =>
    Effect.gen(function* () {
      const { set, phone, laptop, sessions, sessionFor, live } = yield* arrange;
      yield* sessionFor(phone, "phone");
      yield* sessionFor(laptop, "computer");
      // Sessions from a pairing link, a LAN or Tailscale pairing and the desktop app are not devices.
      yield* sessions.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" });
      yield* sessions.issue({ subject: "one-time-token", method: "bearer-access-token" });
      yield* set(mode.visibility({ phone: phone.id }));
      const expected = [
        ...(mode.revokes.includes("phone") ? [] : subjectsOf([phone], "phone")),
        ...(mode.revokes.includes("laptop") ? [] : subjectsOf([laptop], "computer")),
        "desktop-bootstrap",
        "one-time-token",
      ];
      assert.sameMembers(yield* live, expected);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("closes the open socket of a device it hides from, before it returns", () =>
    Effect.gen(function* () {
      const { set, phone, laptop, sessions, sessionFor } = yield* arrange;
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
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isFalse(yield* Deferred.isDone(closed));
      yield* set({ mode: "hidden_from_selected", deviceIds: [phone.id] });
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isTrue(yield* Deferred.isDone(closed));
      assert.equal(
        (yield* sessions.verify(laptopSession.token)).sessionId,
        laptopSession.sessionId,
      );
    }).pipe(Effect.scoped, Effect.provide(layerHarness)),
  );

  it.effect(
    "turning it off again revokes nothing and lets the device sign in on its next pass",
    () =>
      Effect.gen(function* () {
        const { set, phone, exchange, reason, live, sessionFor } = yield* arrange;
        yield* set({ mode: "hidden_from_all", deviceIds: [] });
        assert.equal(reason(yield* exchange(phone)), "device_hidden");
        yield* sessionFor(phone, "phone");
        yield* set({ mode: "visible_to_all", deviceIds: [] });
        assert.lengthOf(yield* live, 1);
        assert.equal((yield* exchange(phone)).status, 200);
      }).pipe(Effect.provide(layerHarness)),
  );
});

describe("a pass from a device this computer hides from", () => {
  it.effect("is refused as device_hidden, however good the pass is, and not as removed", () =>
    Effect.gen(function* () {
      const { set, phone, laptop, exchange, reason, live } = yield* arrange;
      assert.equal((yield* exchange(laptop)).status, 200);
      yield* set({ mode: "hidden_from_selected", deviceIds: [laptop.id] });
      const refused = yield* exchange(laptop);
      assert.equal(refused.status, 401);
      assert.equal(reason(refused), "device_hidden");
      assert.equal(refused.headers["access-control-expose-headers"], "t3x-reason");
      assert.equal((yield* exchange(phone)).status, 200);
      // The laptop's earlier session was revoked by the setting; the phone's new one is the only one left.
      assert.deepEqual(yield* live, subjectsOf([phone], "phone"));
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("applies the four modes, including to a device that joins afterwards", () =>
    Effect.gen(function* () {
      const { set, fake, phone, service, exchange } = yield* arrange;
      const cases: ReadonlyArray<{
        readonly visibility: (selected: string) => DeviceVisibility;
        readonly selectedAccepted: boolean;
        readonly lateAccepted: boolean;
      }> = [
        {
          visibility: () => ({ mode: "visible_to_all", deviceIds: [] }),
          selectedAccepted: true,
          lateAccepted: true,
        },
        {
          visibility: () => ({ mode: "hidden_from_all", deviceIds: [] }),
          selectedAccepted: false,
          lateAccepted: false,
        },
        {
          visibility: (id) => ({ mode: "hidden_from_selected", deviceIds: [id] }),
          selectedAccepted: false,
          lateAccepted: true,
        },
        {
          visibility: (id) => ({ mode: "visible_to_selected", deviceIds: [id] }),
          selectedAccepted: true,
          lateAccepted: false,
        },
      ];
      for (const entry of cases) {
        yield* set(entry.visibility(phone.id));
        const late = fake.addDevice({ kind: "computer", name: `Late ${fake.state.rev}` });
        yield* service.refresh;
        assert.equal(
          (yield* exchange(phone)).status === 200,
          entry.selectedAccepted,
          JSON.stringify(entry.visibility(phone.id)),
        );
        assert.equal(
          (yield* exchange(late)).status === 200,
          entry.lateAccepted,
          `late ${JSON.stringify(entry.visibility(phone.id))}`,
        );
      }
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("is judged from this computer's own file, not from what the registry says", () =>
    Effect.gen(function* () {
      const { set, fake, laptop, service, exchange, reason } = yield* arrange;
      yield* set({ mode: "hidden_from_selected", deviceIds: [laptop.id] });
      // A registry that claims the laptop is allowed (or one nobody can reach) changes nothing.
      fake.state.visibility = { mode: "visible_to_all", deviceIds: [] };
      fake.state.reachable = false;
      assert.equal(reason(yield* exchange(laptop)), "device_hidden");
      fake.state.reachable = true;
      fake.state.visibilitySupported = false;
      yield* service.refresh;
      assert.equal(reason(yield* exchange(laptop)), "device_hidden");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("sees a change made by the CLI in another process without waiting for a sync", () =>
    Effect.gen(function* () {
      const { secrets, laptop, exchange, reason } = yield* arrange;
      assert.equal((yield* exchange(laptop)).status, 200);
      yield* secrets.set(
        DeviceDirectory.VISIBILITY_SECRET,
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            visibility: { mode: "hidden_from_selected", deviceIds: [laptop.id] },
          }),
        ),
      );
      assert.equal(reason(yield* exchange(laptop)), "device_hidden");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("is still refused when the setting is saved while the pass waits for the gate", () =>
    Effect.gen(function* () {
      const { harness, set, laptop, exchange, reason, live } = yield* arrange;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      harness.hooks.onGateRequested = Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const pending = yield* exchange(laptop).pipe(Effect.forkChild);
      yield* Deferred.await(reached);
      harness.hooks.onGateRequested = Effect.void;
      yield* set({ mode: "hidden_from_selected", deviceIds: [laptop.id] });
      yield* Deferred.succeed(release, undefined);
      const response = yield* Fiber.join(pending);
      assert.equal(response.status, 401);
      assert.equal(reason(response), "device_hidden");
      assert.lengthOf(yield* live, 0);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("fails closed when the saved setting cannot be read", () =>
    Effect.gen(function* () {
      const { secrets, phone, exchange, reason, directory } = yield* arrange;
      yield* secrets.set(DeviceDirectory.VISIBILITY_SECRET, new TextEncoder().encode("{not json"));
      assert.equal((yield* directory.visibility).mode, "hidden_from_all");
      assert.equal(reason(yield* exchange(phone)), "device_hidden");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "refuses the pass on an unreadable file but never reports or delivers that guess as the user's setting",
    () =>
      Effect.gen(function* () {
        const { set, secrets, fake, directory, phone, laptop, exchange, reason } = yield* arrange;
        yield* set({ mode: "hidden_from_selected", deviceIds: [phone.id] });
        const delivered = fake.callsTo("setVisibility");
        const saved = Option.getOrThrow(yield* secrets.get(DeviceDirectory.VISIBILITY_SECRET));
        yield* secrets.set(
          DeviceDirectory.VISIBILITY_SECRET,
          new TextEncoder().encode("{not json"),
        );
        const status = yield* directory.sync;
        assert.isTrue(status.visibility?.unreadable);
        // What it still shows is the last setting that was read, not the closed-door guess.
        assert.equal(status.visibility?.mode, "hidden_from_selected");
        assert.deepEqual(status.visibility?.deviceIds, [phone.id]);
        assert.equal(fake.callsTo("setVisibility"), delivered);
        assert.equal(fake.state.visibility.mode, "hidden_from_selected");
        // A device the saved setting would have let in is still refused.
        assert.equal(reason(yield* exchange(laptop)), "device_hidden");
        yield* secrets.set(DeviceDirectory.VISIBILITY_SECRET, saved);
        const repaired = yield* directory.sync;
        assert.isUndefined(repaired.visibility?.unreadable);
        assert.equal(repaired.visibility?.mode, "hidden_from_selected");
        assert.equal((yield* exchange(laptop)).status, 200);
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("still lets a pass from a device hidden from by the registry's list go through", () =>
    Effect.gen(function* () {
      // A computer that hides from this one is missing from its list but listed in `hiddenPeers`;
      // its pass must still be checked against its key, or hiding one way would also block the other.
      const { fake, directory, laptop, service, exchange, sessionFor, live } = yield* arrange;
      const hiddenLaptop = fake.state.devices.find((device) => device.id === laptop.id);
      assert.isDefined(hiddenLaptop);
      fake.state.devices = fake.state.devices.filter((device) => device.id !== laptop.id);
      fake.state.hiddenPeers = [{ id: laptop.id, kind: "computer", jwk: laptop.jwk }];
      yield* sessionFor(laptop, "computer");
      yield* service.refresh;
      assert.deepEqual(yield* live, subjectsOf([laptop], "computer"));
      const listed = Option.getOrThrow((yield* directory.state).list);
      assert.isFalse(listed.devices.some((device) => device.id === laptop.id));
      assert.equal((yield* exchange(laptop)).status, 200);
      // Gone from both is gone: its sessions are revoked and its pass is unknown.
      fake.state.hiddenPeers = [];
      yield* service.refresh;
      assert.lengthOf(yield* live, 0);
    }).pipe(Effect.provide(layerHarness)),
  );
});

describe("telling the registry", () => {
  it.effect("delivers the setting, and reports it synced", () =>
    Effect.gen(function* () {
      const { set, fake, phone } = yield* arrange;
      const status = yield* set({ mode: "visible_to_selected", deviceIds: [phone.id] });
      assert.equal(fake.callsTo("setVisibility"), 1);
      assert.deepEqual(fake.state.visibility, {
        mode: "visible_to_selected",
        deviceIds: [phone.id],
      });
      assert.equal(status.visibility?.registry, "synced");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("says the server is too old, and still applies the setting here", () =>
    Effect.gen(function* () {
      const { set, fake, phone, sessionFor, live } = yield* arrange;
      fake.state.visibilitySupported = false;
      yield* sessionFor(phone, "phone");
      const status = yield* set({ mode: "hidden_from_all", deviceIds: [] });
      assert.equal(status.visibility?.registry, "unsupported");
      assert.equal(status.visibility?.mode, "hidden_from_all");
      assert.equal(fake.callsTo("setVisibility"), 0);
      assert.lengthOf(yield* live, 0);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "keeps the setting pending while the registry cannot be reached, then delivers it",
    () =>
      Effect.gen(function* () {
        const { set, fake, directory, phone, exchange, reason } = yield* arrange;
        fake.state.reachable = false;
        const status = yield* set({ mode: "hidden_from_selected", deviceIds: [phone.id] });
        assert.equal(status.visibility?.registry, "pending");
        assert.equal(reason(yield* exchange(phone)), "device_hidden");
        fake.state.reachable = true;
        assert.equal((yield* directory.sync).visibility?.registry, "synced");
        assert.deepEqual(fake.state.visibility, {
          mode: "hidden_from_selected",
          deviceIds: [phone.id],
        });
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("delivers a setting the CLI saved in another process on the next sync", () =>
    Effect.gen(function* () {
      const { fake, directory, secrets } = yield* arrange;
      yield* secrets.set(
        DeviceDirectory.VISIBILITY_SECRET,
        new TextEncoder().encode(
          JSON.stringify({ v: 1, visibility: { mode: "hidden_from_all", deviceIds: [] } }),
        ),
      );
      const status = yield* directory.sync;
      assert.equal(status.visibility?.mode, "hidden_from_all");
      assert.equal(status.visibility?.registry, "synced");
      assert.equal(fake.state.visibility.mode, "hidden_from_all");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "does not say synced when the setting changed while an older one was being delivered",
    () =>
      Effect.gen(function* () {
        const { fake, directory, secrets, set, phone, laptop } = yield* arrange;
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        fake.state.onSetVisibility = Effect.suspend(() => {
          fake.state.onSetVisibility = Effect.void;
          return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)));
        });
        yield* secrets.set(
          DeviceDirectory.VISIBILITY_SECRET,
          new TextEncoder().encode(
            JSON.stringify({ v: 1, visibility: { mode: "hidden_from_all", deviceIds: [] } }),
          ),
        );
        const first = yield* directory.sync.pipe(Effect.forkChild);
        yield* Deferred.await(reached);
        yield* set({ mode: "hidden_from_selected", deviceIds: [laptop.id, phone.id] });
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        const status = yield* Fiber.join(first);
        assert.deepEqual(fake.state.visibility, {
          mode: "hidden_from_selected",
          deviceIds: [laptop.id, phone.id].sort(),
        });
        assert.equal(status.visibility?.registry, "synced");
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("remembers what the registry said across a restart, for the CLI's next process", () =>
    Effect.gen(function* () {
      const { set, fake, directory, phone } = yield* arrange;
      const context = yield* Effect.context<
        | ServerSecretStore.ServerSecretStore
        | DeviceIdentity.DeviceIdentity
        | RegistryClient.RegistryClient
        | SessionStore.SessionStore
      >();
      const restarted = Effect.gen(function* () {
        const next = yield* DeviceDirectory.DeviceDirectory;
        return (yield* next.status).visibility?.registry;
      }).pipe(
        // `fresh`: the same layer value would otherwise hand back the directory that is already running.
        Effect.provide(
          Layer.fresh(DeviceDirectory.layer).pipe(Layer.provide(Layer.succeedContext(context))),
        ),
        Effect.scoped,
      );
      const hidden = { mode: "hidden_from_selected", deviceIds: [phone.id] } as const;
      yield* set(hidden);
      assert.equal(yield* restarted, "synced");
      // Changed again and not delivered yet: the old confirmation does not carry over.
      fake.state.reachable = false;
      yield* set({ mode: "hidden_from_all", deviceIds: [] });
      assert.equal(yield* restarted, "pending");
      fake.state.reachable = true;
      fake.state.visibilitySupported = false;
      yield* directory.sync;
      assert.equal(yield* restarted, "unsupported");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("re-delivers it when the registry lost it", () =>
    Effect.gen(function* () {
      const { set, fake, directory } = yield* arrange;
      yield* set({ mode: "hidden_from_all", deviceIds: [] });
      fake.state.visibility = { mode: "visible_to_all", deviceIds: [] };
      yield* directory.sync;
      assert.equal(fake.state.visibility.mode, "hidden_from_all");
    }).pipe(Effect.provide(layerHarness)),
  );
});

describe("this computer's own list", () => {
  it.effect(
    "a computer missing from the list is not a removal of this one: it stays joined and keeps its key",
    () =>
      Effect.gen(function* () {
        const { fake, directory, laptop } = yield* arrange;
        // What the registry sends a device the laptop hides from: no laptop, but this computer is there.
        fake.removeDevice(laptop.id);
        const status = yield* directory.sync;
        assert.equal(status.state, "joined");
        assert.equal(status.staleness, "fresh");
        const state = yield* directory.state;
        assert.isTrue(Option.isSome(state.membership));
        assert.isFalse(
          Option.getOrThrow(state.list).devices.some((device) => device.id === laptop.id),
        );
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("a list that no longer holds this computer is still a removal", () =>
    Effect.gen(function* () {
      const { fake, directory } = yield* arrange;
      const self = Option.getOrThrow((yield* directory.state).membership).deviceId;
      fake.removeDevice(self);
      assert.equal((yield* directory.sync).state, "removed");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("fails on a registry error without touching the saved setting", () =>
    Effect.gen(function* () {
      const { set, fake, directory } = yield* arrange;
      yield* set({ mode: "hidden_from_all", deviceIds: [] });
      fake.state.failWith = new RegistryClient.RegistryClientError({ kind: "unreachable" });
      yield* directory.sync;
      assert.equal((yield* directory.visibility).mode, "hidden_from_all");
    }).pipe(Effect.provide(layerHarness)),
  );
});
