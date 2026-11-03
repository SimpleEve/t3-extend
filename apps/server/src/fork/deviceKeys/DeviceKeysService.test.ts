// Join, leave, invite, remove, rename and the local-owner signature, over the fake registry.
import { parseAssertion, verifyAssertionSignature } from "@t3tools/shared/forkDeviceKeys/assertion";
import { encodeInvite } from "@t3tools/shared/forkDeviceKeys/invite";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";
import {
  Harness,
  NOW_MS,
  NOW_S,
  fakeInvite,
  joinThisComputer,
  layerHarness,
} from "./deviceHarness.testkit.ts";
import { FAKE_ORIGIN, FAKE_REGISTRY_ID, FakeRegistry } from "./registryFake.testkit.ts";

const start = Effect.gen(function* () {
  yield* TestClock.setTime(NOW_MS);
  return {
    harness: yield* Harness,
    fake: yield* FakeRegistry,
    service: yield* DeviceKeysService.DeviceKeysService,
    directory: yield* DeviceDirectory.DeviceDirectory,
    identity: yield* DeviceIdentity.DeviceIdentity,
  };
});

const failureOf = <A>(effect: Effect.Effect<A, DeviceKeysService.DeviceKeysServiceError>) =>
  effect.pipe(Effect.flip);

describe("join", () => {
  it.effect("registers this computer, remembers it, and syncs the list", () =>
    Effect.gen(function* () {
      const { harness, fake, service, identity, directory } = yield* start;
      const status = yield* joinThisComputer("Studio");
      assert.equal(status.state, "joined");
      assert.equal(status.name, "Studio");
      assert.equal(status.url, "https://studio.t3.example.test");
      assert.equal(status.registryHost, "t3.example.test");
      assert.equal(status.staleness, "fresh");
      const key = Option.getOrThrow(yield* identity.peek);
      assert.equal(status.deviceId, key.id);
      const joined = fake.state.devices.find((device) => device.id === key.id);
      assert.deepEqual(joined?.jwk, key.jwk);
      assert.equal(joined?.kind, "computer");
      assert.equal(joined?.environmentId, harness.environmentId);
      assert.equal(Option.getOrThrow((yield* directory.state).list).devices.length, 1);
      assert.equal(fake.callsTo("listDevices"), 1);
      assert.equal((yield* service.status).deviceId, key.id);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "refuses invites that are malformed, expired, for phones, or from another address",
    () =>
      Effect.gen(function* () {
        const { fake, service, identity } = yield* start;
        const good = fakeInvite().invite;
        fake.state.invite = "x";
        const cases = [
          ["garbage", "t3x1.not-an-invite"],
          ["expired", encodeInvite({ ...good, expiresAt: NOW_S })],
          ["for phones", encodeInvite({ ...good, kind: "phone" })],
          ["not https", encodeInvite({ ...good, origin: "http://t3.example.test" })],
          ["origin with a path", encodeInvite({ ...good, origin: `${FAKE_ORIGIN}/x` })],
        ] as const;
        for (const [name, invite] of cases) {
          const error = yield* failureOf(service.join({ invite, name: "Studio" }));
          assert.equal(error.reason, "invite_invalid", name);
        }
        assert.equal(fake.callsTo("join"), 0);
        assert.isTrue(Option.isNone(yield* identity.peek));
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("refuses a registry that is not the one the invite names", () =>
    Effect.gen(function* () {
      const { fake, service, identity } = yield* start;
      const other = encodeInvite({ ...fakeInvite().invite, registryId: "otherreg" });
      fake.state.invite = "x";
      const error = yield* failureOf(service.join({ invite: other, name: "Studio" }));
      assert.deepEqual(
        [error.reason, error.registryCode],
        ["registry_rejected", "registry_mismatch"],
      );
      assert.equal(fake.callsTo("join"), 0);
      assert.isTrue(Option.isNone(yield* identity.peek));
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "rejects bad names, double joins and a registry that says no, without keeping a key",
    () =>
      Effect.gen(function* () {
        const { fake, service, identity } = yield* start;
        const invite = fakeInvite();
        fake.state.invite = invite.redemption;
        for (const name of ["", "   ", "x".repeat(41), "tab\there"]) {
          assert.equal(
            (yield* failureOf(service.join({ invite: invite.text, name }))).reason,
            "invalid_input",
          );
        }
        fake.state.invite = "something-else";
        const rejected = yield* failureOf(service.join({ invite: invite.text, name: "Studio" }));
        assert.deepEqual(
          [rejected.reason, rejected.registryCode],
          ["invite_invalid", "invite_invalid"],
        );
        assert.isTrue(Option.isNone(yield* identity.peek));

        fake.state.reachable = false;
        assert.equal(
          (yield* failureOf(service.join({ invite: invite.text, name: "Studio" }))).reason,
          "registry_unreachable",
        );
        fake.state.reachable = true;

        fake.state.invite = invite.redemption;
        yield* service.join({ invite: invite.text, name: "Studio" });
        const again = yield* failureOf(service.join({ invite: invite.text, name: "Studio" }));
        assert.equal(again.reason, "already_joined");
      }).pipe(Effect.provide(layerHarness)),
  );
});

describe("leave", () => {
  it.effect("removes this computer from the registry, then forgets everything locally", () =>
    Effect.gen(function* () {
      const { fake, service, identity } = yield* start;
      const sessions = yield* SessionStore.SessionStore;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* joinThisComputer();
      const peer = fake.addDevice({ kind: "phone", name: "Pixel" });
      yield* service.refresh;
      yield* sessions.issue({
        subject: `t3x-device:phone:${peer.id}`,
        method: "dpop-access-token",
        proofKeyThumbprint: "k".repeat(43),
      });
      const status = yield* service.leave;
      assert.equal(status.state, "not_joined");
      assert.equal(fake.callsTo("removeDevice"), 1);
      assert.deepEqual(
        fake.state.devices.map((device) => device.name),
        ["Pixel"],
      );
      assert.isTrue(Option.isNone(yield* identity.peek));
      assert.isTrue(Option.isNone(yield* secrets.get(DeviceDirectory.MEMBERSHIP_SECRET)));
      assert.isFalse(
        (yield* sessions.listActive()).some((row) => row.subject.startsWith("t3x-device:")),
      );
      assert.equal((yield* failureOf(service.leave)).reason, "not_joined");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "stays joined when the registry cannot be reached, and leaves when it no longer knows us",
    () =>
      Effect.gen(function* () {
        const { fake, service } = yield* start;
        yield* joinThisComputer();
        fake.state.reachable = false;
        assert.equal((yield* failureOf(service.leave)).reason, "registry_unreachable");
        assert.equal((yield* service.status).state, "joined");
        fake.state.reachable = true;
        fake.state.forgetCaller = true;
        assert.equal((yield* service.leave).state, "not_joined");
      }).pipe(Effect.provide(layerHarness)),
  );
});

describe("managing devices", () => {
  it.effect(
    "invites, cancels, renames and removes through the registry, and says who has not synced",
    () =>
      Effect.gen(function* () {
        const { fake, service } = yield* start;
        yield* joinThisComputer();
        const stale = fake.addDevice({
          kind: "computer",
          name: "Old laptop",
          environmentId: "env-old",
          lastSyncAt: 1500,
        });
        const fresh = fake.addDevice({
          kind: "computer",
          name: "New laptop",
          environmentId: "env-new",
          lastSyncAt: 2500,
        });
        const phone = fake.addDevice({ kind: "phone", name: "Pixel" });
        yield* service.refresh;

        assert.deepEqual(yield* service.invite("phone"), {
          id: "AAAAAAAAAAA",
          invite: "t3x1.fake-phone",
          expiresAt: 5000,
        });
        yield* service.cancelInvite("AAAAAAAAAAA");
        assert.equal(fake.callsTo("cancelInvite"), 1);

        assert.deepEqual(yield* service.rename(phone.id, "Pixel 9"), {
          id: phone.id,
          name: "Pixel 9",
        });
        const removal = yield* service.remove(phone.id);
        assert.equal(removal.removedAt, 2000);
        // The old laptop last synced before the removal; the new one after; neither is the removed phone or us.
        assert.deepEqual(removal.pendingComputers, [{ id: stale.id, name: "Old laptop" }]);
        assert.notInclude(
          removal.pendingComputers.map((entry) => entry.id),
          fresh.id,
        );
        // Removing refreshes our own list at once.
        assert.isFalse(
          Option.getOrThrow(
            (yield* DeviceDirectory.DeviceDirectory.pipe(Effect.flatMap((d) => d.state))).list,
          ).devices.some((device) => device.id === phone.id),
        );
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("needs a membership, and will not remove itself through remove", () =>
    Effect.gen(function* () {
      const { service } = yield* start;
      for (const run of [
        service.invite("phone"),
        service.cancelInvite("AAAAAAAAAAA"),
        service.remove("x"),
        service.rename("x", "y"),
        service.leave,
      ]) {
        assert.equal((yield* failureOf(run)).reason, "not_joined");
      }
      const status = yield* joinThisComputer();
      const error = yield* failureOf(service.remove(status.deviceId ?? ""));
      assert.equal(error.reason, "invalid_input");
      assert.equal(
        (yield* failureOf(service.rename(status.deviceId ?? "", "  "))).reason,
        "invalid_input",
      );
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("maps registry refusals to a few reasons the UI can act on", () =>
    Effect.gen(function* () {
      const { fake, service } = yield* start;
      yield* joinThisComputer();
      for (const [code, reason] of [
        ["rate_limited", "rate_limited"],
        ["too_many_invites", "registry_rejected"],
        ["forbidden", "registry_rejected"],
        ["name_invalid", "invalid_input"],
      ] as const) {
        fake.state.rejectWith = code;
        const error = yield* failureOf(service.invite("phone"));
        assert.deepEqual([error.reason, error.registryCode], [reason, code]);
      }
    }).pipe(Effect.provide(layerHarness)),
  );
});

describe("signAssertion", () => {
  const arrange = Effect.gen(function* () {
    const context = yield* start;
    yield* joinThisComputer();
    const laptop = context.fake.addDevice({
      kind: "computer",
      name: "Laptop",
      environmentId: "env-laptop",
    });
    const phone = context.fake.addDevice({
      kind: "phone",
      name: "Pixel",
      environmentId: "env-phone",
    });
    yield* context.service.refresh;
    return { ...context, laptop, phone };
  });
  const jkt = "j".repeat(43);

  it.effect("signs a 60-second pass for another computer, with this computer's key", () =>
    Effect.gen(function* () {
      const { service, identity } = yield* arrange;
      const signed = yield* service.signAssertion({
        audienceEnvironmentId: "env-laptop",
        dpopThumbprint: jkt,
      });
      assert.equal(signed.expiresAt, NOW_S + 60);
      const key = Option.getOrThrow(yield* identity.peek);
      const parsed = parseAssertion(signed.assertion);
      assert.equal(parsed.kid, key.id);
      assert.deepEqual(
        { ...parsed.claims, jti: undefined },
        {
          iss: key.id,
          sub: key.id,
          aud: "env-laptop",
          rid: FAKE_REGISTRY_ID,
          iat: NOW_S,
          exp: NOW_S + 60,
          jti: undefined,
          jkt,
        },
      );
      assert.isTrue(verifyAssertionSignature(parsed, key.jwk));
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("only signs for computers the server's own list names, never itself", () =>
    Effect.gen(function* () {
      const { harness, service } = yield* arrange;
      for (const audienceEnvironmentId of ["env-phone", "env-unknown", harness.environmentId]) {
        const error = yield* failureOf(
          service.signAssertion({ audienceEnvironmentId, dpopThumbprint: jkt }),
        );
        assert.equal(error.reason, "unknown_audience", audienceEnvironmentId);
      }
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("refuses before joining and once the list has expired", () =>
    Effect.gen(function* () {
      const { fake, service } = yield* start;
      assert.equal(
        (yield* failureOf(
          service.signAssertion({ audienceEnvironmentId: "env-laptop", dpopThumbprint: jkt }),
        )).reason,
        "not_joined",
      );
      yield* joinThisComputer();
      fake.addDevice({ kind: "computer", name: "Laptop", environmentId: "env-laptop" });
      yield* service.refresh;
      fake.state.reachable = false;
      yield* TestClock.adjust(Duration.days(8));
      assert.equal(
        (yield* failureOf(
          service.signAssertion({ audienceEnvironmentId: "env-laptop", dpopThumbprint: jkt }),
        )).reason,
        "list_expired",
      );
      fake.state.reachable = true;
      yield* service.refresh;
      yield* service.signAssertion({ audienceEnvironmentId: "env-laptop", dpopThumbprint: jkt });
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("allows 60 passes a minute, then asks the caller to slow down", () =>
    Effect.gen(function* () {
      const { service } = yield* arrange;
      const sign = service.signAssertion({
        audienceEnvironmentId: "env-laptop",
        dpopThumbprint: jkt,
      });
      for (let count = 0; count < DeviceKeysService.SIGN_ASSERTION_PER_MINUTE; count += 1)
        yield* sign;
      assert.equal((yield* failureOf(sign)).reason, "rate_limited");
      yield* TestClock.adjust(Duration.seconds(61));
      yield* sign;
    }).pipe(Effect.provide(layerHarness)),
  );
});
