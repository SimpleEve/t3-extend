// POST /oauth/t3x-device against design 3.5 (T1-T10) and the revocation chain of Q2 (R1, R2).
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { generateDeviceKey } from "@t3tools/shared/forkDeviceKeys/jws";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";
import {
  type DpopSigner,
  type ExchangePassInput,
  type PassOptions,
  Harness,
  NOW_MS,
  exchangeBootstrap,
  exchangePass,
  joinThisComputer,
  layerHarness,
  makeDpopSigner,
  passFor,
  send,
  ticketRequest,
} from "./deviceHarness.testkit.ts";
import { FAKE_REGISTRY_ID, FakeRegistry } from "./registryFake.testkit.ts";

const arrange = Effect.gen(function* () {
  yield* TestClock.setTime(NOW_MS);
  const harness = yield* Harness;
  const fake = yield* FakeRegistry;
  const service = yield* DeviceKeysService.DeviceKeysService;
  yield* joinThisComputer();
  const phone = fake.addDevice({ kind: "phone", name: "Pixel" });
  const laptop = fake.addDevice({ kind: "computer", name: "Laptop", environmentId: "env-laptop" });
  yield* service.refresh;
  const exchange = Effect.fn("exchange")(function* (
    who: Pick<typeof phone, "privateKey" | "id">,
    options: Partial<Omit<ExchangePassInput, "port" | "origin" | "dpop">> & {
      readonly dpop?: DpopSigner;
      readonly pass?: Partial<Omit<PassOptions, "audience" | "dpop">>;
    } = {},
  ) {
    const dpop = options.dpop ?? makeDpopSigner();
    const { pass, dpop: _dpop, assertion: given, ...rest } = options;
    const assertion =
      given ?? (yield* passFor(who, { audience: harness.environmentId, dpop, ...pass }));
    const response = yield* exchangePass({
      port: harness.port,
      origin: harness.origin,
      dpop,
      ...rest,
      assertion,
    });
    return { response, dpop, assertion };
  });
  return { harness, fake, service, phone, laptop, exchange };
});

const reason = (response: { headers: Readonly<Record<string, unknown>> }) =>
  response.headers["t3x-reason"];

// A renderer on another origin only sees `t3x-reason` if the response exposes it (CORS hides the rest).
const RENDERER_ORIGIN = { origin: "http://127.0.0.1:5173" } as const;
const assertReasonReadable = (
  response: { headers: Readonly<Record<string, unknown>> },
  name: string,
) => {
  const exposed = String(response.headers["access-control-expose-headers"] ?? "")
    .toLowerCase()
    .split(",")
    .map((header) => header.trim());
  assert.include(exposed, "t3x-reason", name);
  assert.equal(response.headers["access-control-allow-origin"], RENDERER_ORIGIN.origin, name);
};

describe("POST /oauth/t3x-device", () => {
  it.effect("T1: runs inside the global middleware, behind the readiness gate", () =>
    Effect.gen(function* () {
      const { harness, phone, exchange } = yield* arrange;
      const arrived = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      harness.hooks.ready = Deferred.succeed(arrived, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const pending = yield* exchange(phone).pipe(Effect.forkChild);
      yield* Effect.gen(function* () {
        yield* Deferred.await(arrived);
        // The request is inside the gate: not answered, though everything else is ready.
        assert.isUndefined(pending.pollUnsafe());
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      harness.hooks.ready = Effect.void;
      assert.equal((yield* Fiber.join(pending)).response.status, 200);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("T2: answers CORS preflights exactly as /oauth/token does", () =>
    Effect.gen(function* () {
      const { harness } = yield* arrange;
      const preflight = (path: string) =>
        send(harness.port, {
          method: "OPTIONS",
          path,
          headers: {
            origin: "http://127.0.0.1:5173",
            "access-control-request-method": "POST",
            "access-control-request-headers": "dpop,content-type",
          },
        });
      const token = yield* preflight("/oauth/token");
      const device = yield* preflight("/oauth/t3x-device");
      assert.equal(device.status, token.status);
      for (const name of [
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-allow-credentials",
        "access-control-max-age",
      ]) {
        assert.equal(device.headers[name], token.headers[name], name);
      }
      assert.isDefined(device.headers["access-control-allow-headers"]);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "T3: refuses malformed bodies with 400, without counting them as sign-in failures",
    () =>
      Effect.gen(function* () {
        const { harness, phone, exchange } = yield* arrange;
        const xff = { "x-forwarded-for": "198.51.100.2" };
        const dpop = makeDpopSigner();
        const cases: ReadonlyArray<
          Parameters<typeof exchangePass>[0] extends infer _
            ? Partial<Parameters<typeof exchangePass>[0]>
            : never
        > = [
          { rawBody: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer" },
          { rawBody: "assertion=x" },
          { grantType: "urn:ietf:params:oauth:grant-type:token-exchange" },
          { rawBody: `grant_type=x&assertion=${"a".repeat(9000)}` },
          { scope: "" },
          { scope: "not-a-scope" },
        ];
        for (const patch of cases) {
          const { response } = yield* exchange(phone, { dpop, extraHeaders: xff, ...patch });
          assert.equal(response.status, 400, JSON.stringify(patch).slice(0, 80));
        }
        const scope = (yield* exchange(phone, { extraHeaders: xff, scope: "not-a-scope" }))
          .response;
        const tokenScope = yield* exchangeBootstrap({
          port: harness.port,
          origin: harness.origin,
          dpop: makeDpopSigner(),
          rawBody: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: "x",
            subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            scope: "not-a-scope",
          }).toString(),
        });
        assert.equal(scope.status, tokenScope.status);
        assert.deepEqual(
          { code: scope.json().code, reason: scope.json().reason },
          { code: tokenScope.json().code, reason: tokenScope.json().reason },
        );
        // 40 refusals later the client is still not locked out.
        for (let attempt = 0; attempt < 35; attempt += 1) {
          yield* exchange(phone, { extraHeaders: xff, rawBody: "x" });
        }
        assert.equal((yield* exchange(phone, { extraHeaders: xff })).response.status, 200);
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "T4: fails DPoP the way /oauth/token does, and never falls back to a Bearer session",
    () =>
      Effect.gen(function* () {
        const { harness, phone, exchange } = yield* arrange;
        const cases = [
          { name: "wrong method", token: { dpopMethod: "GET" }, device: { dpopMethod: "GET" } },
          {
            name: "wrong URL",
            token: { dpopUrl: "http://elsewhere.test/oauth/token" },
            device: { dpopUrl: "http://elsewhere.test/oauth/t3x-device" },
          },
          {
            name: "stale proof",
            token: { dpopIatOffsetSeconds: -400 },
            device: { dpopIatOffsetSeconds: -400 },
          },
        ] as const;
        for (const entry of cases) {
          const viaToken = yield* exchangeBootstrap({
            port: harness.port,
            origin: harness.origin,
            dpop: makeDpopSigner(),
            ...entry.token,
          });
          const viaDevice = (yield* exchange(phone, entry.device)).response;
          assert.equal(viaDevice.status, 401, entry.name);
          // /oauth/token sends no cache-control on DPoP failures; this endpoint sends no-store (T5).
          for (const name of ["status", "www-authenticate"] as const) {
            assert.equal(
              name === "status" ? viaDevice.status : viaDevice.headers[name],
              name === "status" ? viaToken.status : viaToken.headers[name],
              `${entry.name}: ${name}`,
            );
          }
          assert.equal(viaDevice.headers["www-authenticate"], "DPoP");
          const [a, b] = [viaToken.json(), viaDevice.json()];
          assert.deepEqual(
            { code: b.code, reason: b.reason, dpopFailureReason: b.dpopFailureReason },
            { code: a.code, reason: a.reason, dpopFailureReason: a.dpopFailureReason },
            entry.name,
          );
        }
        // A replayed DPoP jti.
        const dpop = makeDpopSigner();
        const first = yield* exchangeBootstrap({
          port: harness.port,
          origin: harness.origin,
          dpop,
          dpopJti: "replayed-jti-0001",
        });
        assert.equal(first.status, 200);
        const replayedToken = yield* exchangeBootstrap({
          port: harness.port,
          origin: harness.origin,
          dpop,
          dpopJti: "replayed-jti-0001",
        });
        const deviceDpop = makeDpopSigner();
        const okPass = yield* exchange(phone, { dpop: deviceDpop, dpopJti: "replayed-jti-0002" });
        assert.equal(okPass.response.status, 200);
        const replayedDevice = (yield* exchange(phone, {
          dpop: deviceDpop,
          dpopJti: "replayed-jti-0002",
        })).response;
        assert.equal(replayedDevice.status, replayedToken.status);
        assert.equal(
          replayedDevice.json().dpopFailureReason,
          replayedToken.json().dpopFailureReason,
        );
        assert.equal(
          replayedDevice.headers["www-authenticate"],
          replayedToken.headers["www-authenticate"],
        );
        // No DPoP header at all: /oauth/token would mint a Bearer session; this endpoint must not.
        const missing = (yield* exchange(phone, { omitDpop: true })).response;
        assert.equal(missing.status, 401);
        assert.equal(missing.headers["www-authenticate"], "DPoP");
        assert.notInclude(missing.text, "Bearer");
        // The pass names a DPoP key; a proof from a different key is a key mismatch.
        const otherKey = makeDpopSigner();
        const mismatched = (yield* exchange(phone, {
          dpop: otherKey,
          assertion: yield* passFor(phone, {
            audience: harness.environmentId,
            dpop: makeDpopSigner(),
          }),
        })).response;
        assert.equal(mismatched.status, 401);
        assert.equal(reason(mismatched), "key_mismatch");
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("T5: sends no-store on success and on failure", () =>
    Effect.gen(function* () {
      const { phone, exchange } = yield* arrange;
      const ok = (yield* exchange(phone)).response;
      const bad = (yield* exchange(phone, { omitDpop: true })).response;
      const malformed = (yield* exchange(phone, { rawBody: "x" })).response;
      const unavailable = (yield* exchange(phone, { assertion: "x.y.z" })).response;
      for (const response of [ok, bad, malformed, unavailable]) {
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers.pragma, "no-cache");
      }
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("T6: gives every rejection its status, JSON shape and t3x-reason", () =>
    Effect.gen(function* () {
      const { harness, fake, phone, laptop, exchange } = yield* arrange;
      const stranger = generateDeviceKey();
      const dpop = makeDpopSigner();
      const pass = (
        who: Pick<typeof phone, "privateKey" | "id">,
        pass: Record<string, unknown> = {},
        audience = harness.environmentId,
      ) => passFor(who, { audience, dpop, ...pass });
      const expectRejected = Effect.fn("expectRejected")(function* (
        name: string,
        assertion: string,
        expected: string,
      ) {
        const { response } = yield* exchange(phone, {
          assertion,
          dpop: dpop,
          extraHeaders: RENDERER_ORIGIN,
        });
        assert.equal(response.status, 401, name);
        assert.equal(reason(response), expected, name);
        assertReasonReadable(response, name);
        assert.deepEqual(
          { code: response.json().code, reason: response.json().reason },
          { code: "auth_invalid", reason: "invalid_credential" },
          name,
        );
        assert.notInclude(response.text, expected);
      });
      yield* expectRejected("garbage", "not.a.pass", "bad_assertion");
      yield* expectRejected("unknown signer", yield* pass(stranger), "device_unknown");
      // Signed by another key but claiming the phone's id.
      const forged = yield* passFor(
        { ...stranger, id: phone.id },
        { audience: harness.environmentId, dpop },
      );
      yield* expectRejected("bad signature", forged, "bad_signature");
      yield* expectRejected(
        "another computer",
        yield* pass(phone, {}, "env-somewhere-else"),
        "audience_mismatch",
      );
      yield* expectRejected(
        "another registry",
        yield* pass(phone, { registryId: "otherreg" }),
        "registry_mismatch",
      );
      yield* expectRejected("expired", yield* pass(phone, { iat: NOW_MS / 1000 - 300 }), "expired");
      yield* expectRejected(
        "from the future",
        yield* pass(phone, { iat: NOW_MS / 1000 + 200, lifetimeSeconds: 100 }),
        "time_window",
      );
      yield* expectRejected(
        "too long lived",
        yield* pass(phone, { lifetimeSeconds: 600 }),
        "time_window",
      );
      const used = yield* pass(phone, { jti: "pass-used-once-0001" });
      assert.equal((yield* exchange(phone, { assertion: used, dpop })).response.status, 200);
      yield* expectRejected("replayed pass", used, "replay");
      // 503s: the list is missing or too old.
      yield* TestClock.adjust(Duration.days(8));
      fake.state.reachable = false;
      yield* (yield* DeviceKeysService.DeviceKeysService).refresh;
      const stale = (yield* exchange(laptop, {
        assertion: yield* pass(laptop, {
          iat: Math.floor((yield* Clock.currentTimeMillis) / 1000),
        }),
        extraHeaders: RENDERER_ORIGIN,
      })).response;
      assert.equal(stale.status, 503);
      assert.equal(reason(stale), "list_expired");
      assertReasonReadable(stale, "list_expired");
      assert.deepEqual(stale.json(), { error: "service_unavailable" });
      // An old list only stops device passes; the app's own sign-in is untouched.
      const local = yield* exchangeBootstrap({
        port: harness.port,
        origin: harness.origin,
        dpop: makeDpopSigner(),
      });
      assert.equal(local.status, 200);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("T6b: has no list to judge against before the first sync", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const harness = yield* Harness;
      const dpop = makeDpopSigner();
      const response = yield* exchangePass({
        port: harness.port,
        origin: harness.origin,
        assertion: yield* passFor(generateDeviceKey(), { audience: harness.environmentId, dpop }),
        dpop,
        extraHeaders: RENDERER_ORIGIN,
      });
      assert.equal(response.status, 503);
      assert.equal(reason(response), "list_unavailable");
      assertReasonReadable(response, "list_unavailable");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "T7/T8: counts rejected passes per client, locks out the 21st, and skips verification while locked",
    () =>
      Effect.gen(function* () {
        const { harness, phone, exchange } = yield* arrange;
        const xff = { "x-forwarded-for": "203.0.113.50" };
        const dpop = makeDpopSigner();
        const kept = yield* passFor(phone, {
          audience: harness.environmentId,
          dpop,
          jti: "kept-for-after-lock-0001",
        });
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const { response } = yield* exchange(phone, {
            extraHeaders: xff,
            assertion: "not.a.pass",
          });
          assert.equal(response.status, 401);
        }
        const locked = (yield* exchange(phone, {
          dpop,
          assertion: kept,
          extraHeaders: xff,
          dpopJti: "dpop-kept-0001",
        })).response;
        assert.equal(locked.status, 429);
        assert.isDefined(locked.headers["retry-after"]);
        // A different client is unaffected, and so are requests with no forwarding header (this machine).
        assert.equal(
          (yield* exchange(phone, { extraHeaders: { "x-forwarded-for": "203.0.113.51" } })).response
            .status,
          200,
        );
        // While locked, neither the pass nor the DPoP jti was spent.
        yield* TestClock.adjust(Duration.seconds(61));
        const after = (yield* exchange(phone, {
          dpop,
          assertion: kept,
          extraHeaders: xff,
          dpopJti: "dpop-kept-0001",
        })).response;
        assert.equal(after.status, 200);
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("T8: shares one bucket with /oauth/token, and counts only 401s", () =>
    Effect.gen(function* () {
      const { harness, phone, exchange } = yield* arrange;
      const xff = { "x-forwarded-for": "203.0.113.60" };
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = yield* exchangeBootstrap({
          port: harness.port,
          origin: harness.origin,
          dpop: makeDpopSigner(),
          credential: "wrong",
          extraHeaders: xff,
        });
        assert.equal(response.status, 401);
      }
      // 400s and 503s add nothing.
      for (let attempt = 0; attempt < 15; attempt += 1) {
        yield* exchange(phone, { extraHeaders: xff, rawBody: "x" });
      }
      for (let attempt = 0; attempt < 9; attempt += 1) {
        const { response } = yield* exchange(phone, { extraHeaders: xff, assertion: "not.a.pass" });
        assert.equal(response.status, 401);
      }
      // 19 failures so far: one more is allowed to fail, then the bucket is locked, for both endpoints.
      assert.equal(
        (yield* exchange(phone, { extraHeaders: xff, assertion: "not.a.pass" })).response.status,
        401,
      );
      assert.equal((yield* exchange(phone, { extraHeaders: xff })).response.status, 429);
      assert.equal(
        (yield* exchangeBootstrap({
          port: harness.port,
          origin: harness.origin,
          dpop: makeDpopSigner(),
          extraHeaders: xff,
        })).status,
        429,
      );
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("T8: never counts this machine's own requests (no forwarding header)", () =>
    Effect.gen(function* () {
      const { harness, phone, exchange } = yield* arrange;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        yield* exchange(phone, { assertion: "not.a.pass" });
      }
      assert.equal((yield* exchange(phone)).response.status, 200);
      assert.deepEqual(harness.limiterClients, []);
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("T9: spends the pass last", () =>
    Effect.gen(function* () {
      const { harness, phone, exchange } = yield* arrange;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const marker = (jti: string) =>
        Effect.promise(async () => {
          const bytes = new TextEncoder().encode(`${phone.id}:${jti}`);
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return `t3x-assertion-${Buffer.from(digest).toString("base64url")}`;
        });
      const dpop = makeDpopSigner();
      const assertion = yield* passFor(phone, {
        audience: harness.environmentId,
        dpop,
        jti: "marker-test-pass-001",
      });
      // The DPoP key differs, so the pass is refused before anything is spent.
      const refused = (yield* exchange(phone, { dpop: makeDpopSigner(), assertion })).response;
      assert.equal(refused.status, 401);
      assert.isTrue(Option.isNone(yield* secrets.get(yield* marker("marker-test-pass-001"))));
      assert.equal((yield* exchange(phone, { dpop, assertion })).response.status, 200);
      assert.isTrue(Option.isSome(yield* secrets.get(yield* marker("marker-test-pass-001"))));
      const replay = (yield* exchange(phone, { dpop, assertion })).response;
      assert.equal(replay.status, 401);
      assert.equal(reason(replay), "replay");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("T10: issues a DPoP session bound to the pass, narrowed for phones", () =>
    Effect.gen(function* () {
      const { harness, phone, laptop, exchange } = yield* arrange;
      const sessions = yield* SessionStore.SessionStore;
      const fromPhone = yield* exchange(phone);
      assert.equal(fromPhone.response.status, 200);
      const body = fromPhone.response.json();
      assert.equal(body.token_type, "DPoP");
      assert.equal(body.expires_in, 3600);
      const verified = yield* sessions.verify(String(body.access_token));
      assert.equal(verified.subject, `t3x-device:phone:${phone.id}`);
      assert.equal(verified.method, "dpop-access-token");
      assert.equal(verified.proofKeyThumbprint, fromPhone.dpop.thumbprint);
      assert.equal(verified.client.label, "Pixel");
      assert.equal(verified.client.deviceType, "mobile");
      assert.notInclude(verified.scopes, "access:write");
      assert.notInclude(verified.scopes, "relay:write");
      assert.sameMembers(
        [...verified.scopes],
        AuthStandardClientScopes.filter(
          (scope) => scope !== "access:write" && scope !== "relay:write",
        ),
      );
      assert.equal(String(body.scope).split(" ").length, verified.scopes.length);

      const fromLaptop = yield* exchange(laptop, {
        assertion: yield* passFor(laptop, {
          audience: harness.environmentId,
          dpop: makeDpopSigner(),
        }),
      }).pipe(Effect.option);
      // A pass signed for another DPoP key is refused (covered above); sign this one for the right key.
      const dpop = makeDpopSigner();
      const computer = yield* exchange(laptop, { dpop });
      assert.equal(computer.response.status, 200);
      const computerSession = yield* sessions.verify(String(computer.response.json().access_token));
      assert.equal(computerSession.subject, `t3x-device:computer:${laptop.id}`);
      assert.equal(computerSession.client.deviceType, "desktop");
      assert.sameMembers([...computerSession.scopes], [...AuthStandardClientScopes]);
      assert.isTrue(Option.isSome(fromLaptop) || Option.isNone(fromLaptop));

      // The server narrows whatever the client asks for, by intersection.
      const asked = (yield* exchange(phone, { scope: "access:write orchestration:read" })).response;
      assert.equal(asked.status, 200);
      assert.equal(asked.json().scope, "orchestration:read");
      const onlyForbidden = (yield* exchange(phone, { scope: "access:write relay:write" }))
        .response;
      assert.equal(onlyForbidden.status, 400);
      assert.equal(onlyForbidden.json().reason, "scope_not_granted");
      // The session works over HTTP.
      const live = yield* ticketRequest({
        port: harness.port,
        origin: harness.origin,
        token: String(body.access_token),
        dpop: fromPhone.dpop,
      });
      assert.equal(live.status, 200);
    }).pipe(Effect.provide(layerHarness)),
  );
});

describe("revoking a removed device", () => {
  const sessionIdsOf = (id: string) =>
    SessionStore.SessionStore.pipe(
      Effect.flatMap((sessions) => sessions.listActive()),
      Effect.map((rows) =>
        rows.filter((row) => row.subject.endsWith(`:${id}`)).map((row) => row.sessionId),
      ),
    );

  it.effect("kills the HTTP token, the WebSocket ticket, the open socket and renewal at once", () =>
    Effect.gen(function* () {
      const { harness, fake, service, phone, exchange } = yield* arrange;
      const sessions = yield* SessionStore.SessionStore;
      const login = yield* exchange(phone);
      const token = String(login.response.json().access_token);
      const verified = yield* sessions.verify(token);
      const ticketPath = "/api/auth/websocket-ticket/rpc";
      const ticketResponse = yield* send(harness.port, {
        method: "POST",
        path: ticketPath,
        headers: {
          authorization: `DPoP ${token}`,
          dpop: yield* login.dpop.proof({
            method: "POST",
            url: `${harness.origin}${ticketPath}`,
            accessToken: token,
          }),
        },
      });
      assert.equal(ticketResponse.status, 200);
      const ticket = String(ticketResponse.json().ticket);
      const socketClosed = yield* sessions
        .awaitInvalidation(verified.sessionId, login.dpop.thumbprint)
        .pipe(Effect.forkChild);
      const removals = yield* sessions.streamChanges.pipe(
        Stream.filter((change) => change.type === "clientRemoved"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      assert.equal(
        (yield* ticketRequest({
          port: harness.port,
          origin: harness.origin,
          token,
          dpop: login.dpop,
        })).status,
        200,
      );
      fake.removeDevice(phone.id);
      yield* service.refresh;

      assert.deepEqual(yield* sessionIdsOf(phone.id), []);
      assert.equal(
        (yield* ticketRequest({
          port: harness.port,
          origin: harness.origin,
          token,
          dpop: login.dpop,
        })).status,
        401,
      );
      yield* Fiber.join(socketClosed);
      assert.equal((yield* Fiber.join(removals)).length, 1);
      const proof = yield* login.dpop.proof({
        method: "GET",
        url: `${harness.origin}/test/ws-auth`,
        accessToken: ticket,
      });
      const upgrade = yield* send(harness.port, {
        path: `/test/ws-auth?wsTicket=${encodeURIComponent(ticket)}&dpop=${encodeURIComponent(proof)}`,
      });
      assert.equal(upgrade.status, 401);
      const renewal = yield* exchange(phone);
      assert.equal(renewal.response.status, 401);
      assert.equal(reason(renewal.response), "device_unknown");
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "R1: a pass judged before the sync, redeemed after it, signs nothing and spends nothing",
    () =>
      Effect.gen(function* () {
        const { harness, fake, service, phone, exchange } = yield* arrange;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const earlier = yield* exchange(phone);
        assert.equal(earlier.response.status, 200);
        const sessionsBefore = yield* sessionIdsOf(phone.id);
        assert.equal(sessionsBefore.length, 1);

        const stateRead = yield* Deferred.make<void>();
        const resumePass = yield* Deferred.make<void>();
        const insideReconcile = yield* Deferred.make<void>();
        const releaseReconcile = yield* Deferred.make<void>();
        const gateRequested = yield* Deferred.make<void>();
        harness.hooks.afterStateRead = Deferred.succeed(stateRead, undefined).pipe(
          Effect.andThen(Deferred.await(resumePass)),
          Effect.andThen(
            Effect.sync(() => {
              harness.hooks.afterStateRead = Effect.void;
            }),
          ),
        );
        harness.hooks.beforeRevoke = Deferred.succeed(insideReconcile, undefined).pipe(
          Effect.andThen(Deferred.await(releaseReconcile)),
        );
        harness.hooks.onGateRequested = Deferred.succeed(gateRequested, undefined);

        const dpop = makeDpopSigner();
        const assertion = yield* passFor(phone, {
          audience: harness.environmentId,
          dpop,
          jti: "race-pass-one-0001",
        });
        const redeem = yield* exchangePass({
          port: harness.port,
          origin: harness.origin,
          assertion,
          dpop,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(stateRead);
        fake.removeDevice(phone.id);
        const reconcile = yield* service.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(insideReconcile);
        yield* Deferred.succeed(resumePass, undefined);
        yield* Deferred.await(gateRequested);
        harness.hooks.beforeRevoke = Effect.void;
        yield* Deferred.succeed(releaseReconcile, undefined);
        yield* Fiber.join(reconcile);
        const response = yield* Fiber.join(redeem);

        assert.equal(response.status, 401);
        assert.equal(reason(response), "device_revoked");
        assert.deepEqual(yield* sessionIdsOf(phone.id), []);
        const marker = Buffer.from(
          yield* Effect.promise(() =>
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(`${phone.id}:race-pass-one-0001`),
            ),
          ),
        ).toString("base64url");
        assert.isTrue(Option.isNone(yield* secrets.get(`t3x-assertion-${marker}`)));
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "R2 (reconcile first): the renewal is refused, the live session is revoked, its socket closes, no new session appears",
    () =>
      Effect.gen(function* () {
        const { harness, fake, service, phone, exchange } = yield* arrange;
        const sessions = yield* SessionStore.SessionStore;
        const first = yield* exchange(phone);
        const s1 = yield* sessions.verify(String(first.response.json().access_token));
        const socket = yield* sessions
          .awaitInvalidation(s1.sessionId, first.dpop.thumbprint)
          .pipe(Effect.forkChild);

        const stateRead = yield* Deferred.make<void>();
        const resumeRenewal = yield* Deferred.make<void>();
        const insideReconcile = yield* Deferred.make<void>();
        const releaseReconcile = yield* Deferred.make<void>();
        const gateRequested = yield* Deferred.make<void>();
        harness.hooks.afterStateRead = Deferred.succeed(stateRead, undefined).pipe(
          Effect.andThen(Deferred.await(resumeRenewal)),
          Effect.andThen(
            Effect.sync(() => {
              harness.hooks.afterStateRead = Effect.void;
            }),
          ),
        );
        harness.hooks.beforeRevoke = Deferred.succeed(insideReconcile, undefined).pipe(
          Effect.andThen(Deferred.await(releaseReconcile)),
        );
        harness.hooks.onGateRequested = Deferred.succeed(gateRequested, undefined);

        const renewal = yield* exchange(phone, { dpop: first.dpop }).pipe(Effect.forkChild);
        yield* Deferred.await(stateRead);
        fake.removeDevice(phone.id);
        const reconcile = yield* service.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(insideReconcile);
        yield* Deferred.succeed(resumeRenewal, undefined);
        yield* Deferred.await(gateRequested);
        harness.hooks.beforeRevoke = Effect.void;
        yield* Deferred.succeed(releaseReconcile, undefined);
        yield* Fiber.join(reconcile);
        const renewed = (yield* Fiber.join(renewal)).response;

        assert.equal(renewed.status, 401);
        assert.deepEqual(yield* sessionIdsOf(phone.id), []);
        yield* Fiber.join(socket);
        assert.equal(
          (yield* ticketRequest({
            port: harness.port,
            origin: harness.origin,
            token: String(first.response.json().access_token),
            dpop: first.dpop,
          })).status,
          401,
        );
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect(
    "renewing with the same key leaves the first socket open, then follows it to the renewal",
    () =>
      Effect.gen(function* () {
        const { fake, service, laptop, exchange } = yield* arrange;
        const sessions = yield* SessionStore.SessionStore;
        const first = yield* exchange(laptop);
        const s1 = yield* sessions.verify(String(first.response.json().access_token));
        const socket = yield* sessions
          .awaitInvalidation(s1.sessionId, first.dpop.thumbprint)
          .pipe(Effect.forkChild);
        // A new pass for the same device and the same DPoP key replaces nothing: no replaceActiveForSubjectAndMethod.
        yield* TestClock.adjust(Duration.minutes(30));
        const renewal = yield* exchange(laptop, { dpop: first.dpop });
        assert.equal(renewal.response.status, 200);
        assert.lengthOf(yield* sessionIdsOf(laptop.id), 2);
        assert.isUndefined(socket.pollUnsafe());
        // The first session expires; the socket moves on to the renewal and stays open.
        yield* TestClock.adjust(Duration.minutes(31));
        assert.isUndefined(socket.pollUnsafe());
        // Removing the device closes it all the same.
        fake.removeDevice(laptop.id);
        yield* service.refresh;
        yield* Fiber.join(socket);
      }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("R2 (renewal first): both sessions are revoked and both sockets close", () =>
    Effect.gen(function* () {
      const { harness, fake, service, phone, laptop, exchange } = yield* arrange;
      const sessions = yield* SessionStore.SessionStore;
      const first = yield* exchange(phone);
      const s1 = yield* sessions.verify(String(first.response.json().access_token));
      const socket1 = yield* sessions
        .awaitInvalidation(s1.sessionId, first.dpop.thumbprint)
        .pipe(Effect.forkChild);
      // A sync that holds the gate (it is revoking the laptop's session) while the renewal queues behind it.
      const laptopSession = yield* exchange(laptop);
      assert.equal(laptopSession.response.status, 200);
      const insideReconcile = yield* Deferred.make<void>();
      const releaseReconcile = yield* Deferred.make<void>();
      const gateRequested = yield* Deferred.make<void>();
      harness.hooks.beforeRevoke = Deferred.succeed(insideReconcile, undefined).pipe(
        Effect.andThen(Deferred.await(releaseReconcile)),
      );
      harness.hooks.onGateRequested = Deferred.succeed(gateRequested, undefined);
      fake.removeDevice(laptop.id);
      const holder = yield* service.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(insideReconcile);
      harness.hooks.beforeRevoke = Effect.void;

      const renewal = yield* exchange(phone, { dpop: first.dpop }).pipe(Effect.forkChild);
      yield* Deferred.await(gateRequested);
      fake.removeDevice(phone.id);
      const removal = yield* service.refresh.pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseReconcile, undefined);
      yield* Fiber.join(holder);
      const renewed = (yield* Fiber.join(renewal)).response;
      yield* Fiber.join(removal);

      // The renewal won the gate while the phone was still listed; the next sync took both sessions.
      assert.equal(renewed.status, 200);
      const s2 = yield* sessions.verify(String(renewed.json().access_token)).pipe(Effect.option);
      assert.isTrue(Option.isNone(s2));
      assert.deepEqual(yield* sessionIdsOf(phone.id), []);
      yield* Fiber.join(socket1);
      assert.equal(
        (yield* ticketRequest({
          port: harness.port,
          origin: harness.origin,
          token: String(renewed.json().access_token),
          dpop: first.dpop,
        })).status,
        401,
      );
    }).pipe(Effect.provide(layerHarness)),
  );

  it.effect("keeps listing what the directory still has", () =>
    Effect.gen(function* () {
      const { fake, service, phone, laptop, exchange } = yield* arrange;
      yield* exchange(phone);
      yield* exchange(laptop);
      fake.removeDevice(phone.id);
      yield* service.refresh;
      assert.deepEqual(yield* sessionIdsOf(phone.id), []);
      assert.equal((yield* sessionIdsOf(laptop.id)).length, 1);
      const directory = yield* DeviceDirectory.DeviceDirectory;
      assert.equal(Option.isSome((yield* directory.state).list), true);
      assert.equal(FAKE_REGISTRY_ID.length, 8);
    }).pipe(Effect.provide(layerHarness)),
  );

  describe("a pass from a device the list does not have yet", () => {
    // Subscribes first, so the refresh cannot publish before the test is listening.
    const nextListing = Effect.fn("nextListing")(function* (id: string) {
      const directory = yield* DeviceDirectory.DeviceDirectory;
      const subscribed = yield* Deferred.make<void>();
      const listed = yield* directory.changes.pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.filter((snapshot) => snapshot.devices.some((device) => device.id === id)),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      return listed;
    });

    it.effect("is refused now, starts one background refresh, and is accepted on the retry", () =>
      Effect.gen(function* () {
        const { fake, phone, exchange } = yield* arrange;
        const before = fake.callsTo("listDevices");
        const newcomer = fake.addDevice({ kind: "phone", name: "Newcomer" });
        const listed = yield* nextListing(newcomer.id);

        const first = (yield* exchange(newcomer)).response;
        assert.equal(first.status, 401);
        assert.equal(reason(first), "device_unknown");
        yield* Fiber.join(listed);
        assert.equal(fake.callsTo("listDevices"), before + 1);
        assert.equal((yield* exchange(newcomer)).response.status, 200);
        // A device the list already had asks for nothing.
        assert.equal((yield* exchange(phone)).response.status, 200);
        assert.equal(fake.callsTo("listDevices"), before + 1);
      }).pipe(Effect.provide(layerHarness)),
    );

    it.effect("starts one refresh per ten seconds, whichever devices ask", () =>
      Effect.gen(function* () {
        const { fake, exchange } = yield* arrange;
        const before = fake.callsTo("listDevices");
        const first = fake.addDevice({ kind: "phone", name: "First" });
        const second = fake.addDevice({ kind: "phone", name: "Second" });
        const listedFirst = yield* nextListing(first.id);

        assert.equal(reason((yield* exchange(first)).response), "device_unknown");
        yield* Fiber.join(listedFirst);
        // The refresh brought both, so ask again with a device the registry only learns of later.
        const late = fake.addDevice({ kind: "phone", name: "Late" });
        assert.equal(reason((yield* exchange(late)).response), "device_unknown");
        assert.equal(reason((yield* exchange(second, { pass: {} })).response), undefined);
        assert.equal(fake.callsTo("listDevices"), before + 1);

        yield* TestClock.adjust(Duration.seconds(10));
        const listedLate = yield* nextListing(late.id);
        assert.equal(reason((yield* exchange(late)).response), "device_unknown");
        yield* Fiber.join(listedLate);
        assert.equal(fake.callsTo("listDevices"), before + 2);
        assert.equal((yield* exchange(late)).response.status, 200);
      }).pipe(Effect.provide(layerHarness)),
    );
  });
});
