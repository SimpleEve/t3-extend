// The ticket RPC and the capability bit (design 3.2, 5.4, 8): who is offered the gateway, what the
// RPC refuses with, and what the ticket it mints carries.
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentAuthorizationError,
  FORK_LOOPBACK_GATEWAY_WS_METHODS,
  LOOPBACK_GATEWAY_TICKET_AUDIENCE,
  LoopbackGatewayUnavailableError,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import {
  GatewayAvailabilityOverride,
  loopbackGatewayAvailability,
  loopbackGatewayCapability,
} from "./GatewayAvailability.ts";
import { GatewayLimits, makeGatewayLimits } from "./GatewayLimits.ts";
import { makeLoopbackGatewayRpcHandlers } from "./rpcHandlers.ts";
import { GATEWAY_SCOPES, Gateway, layerGateway } from "./gatewayHarness.testkit.ts";
import { memoryGrants } from "./grants.testkit.ts";
import { LoopbackGatewayGrants } from "./LoopbackGatewayGrants.ts";

describe("capability advertisement", () => {
  const cases = [
    { platform: "darwin", env: {}, available: true },
    { platform: "darwin", env: { T3CODE_PORT_DISCOVERY: "1" }, available: true },
    { platform: "darwin", env: { T3CODE_PORT_DISCOVERY: "0" }, reason: "discovery-disabled" },
    { platform: "linux", env: {}, reason: "unsupported-platform" },
    { platform: "win32", env: {}, reason: "unsupported-platform" },
    { platform: "win32", env: { T3CODE_PORT_DISCOVERY: "0" }, reason: "unsupported-platform" },
  ] as const;
  it.each(cases)("$platform with $env", (row) => {
    const result = loopbackGatewayAvailability(row.platform, row.env);
    if ("available" in row) {
      assert.deepEqual(result, { available: true });
      assert.deepEqual(loopbackGatewayCapability(row.platform, row.env), {
        loopbackGateway: true,
      });
    } else {
      assert.deepEqual(result, { available: false, reason: row.reason });
      assert.deepEqual(loopbackGatewayCapability(row.platform, row.env), {});
    }
  });
});

const issueTicket = (session: Parameters<typeof makeLoopbackGatewayRpcHandlers>[0]) =>
  Effect.gen(function* () {
    const handlers = yield* makeLoopbackGatewayRpcHandlers(session);
    return yield* handlers[FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket]();
  }).pipe(Effect.provideService(LoopbackGatewayGrants, memoryGrants()));

describe("loopbackGateway.issueTicket", () => {
  it.effect("mints a ticket for the gateway audience that carries the session's DPoP key", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const row = yield* gateway.sessions.issue({
        subject: "device",
        method: "dpop-access-token",
        scopes: GATEWAY_SCOPES,
        proofKeyThumbprint: "dpop-key-rpc",
        client: { label: "rpc", deviceType: "desktop" },
      });
      const result = yield* issueTicket({
        sessionId: row.sessionId,
        proofKeyThumbprint: "dpop-key-rpc",
      });
      assert.deepEqual(Object.keys(result).toSorted(), ["expiresAt", "ticket"]);
      const verified = yield* gateway.sessions.verifyWebSocketToken(Redacted.value(result.ticket));
      assert.equal(verified.audience, LOOPBACK_GATEWAY_TICKET_AUDIENCE);
      assert.equal(verified.sessionId, row.sessionId);
      assert.equal(verified.proofKeyThumbprint, "dpop-key-rpc");
      assert.equal(String(result.ticket), "<redacted>");
    }).pipe(Effect.provide(layerGateway)),
  );

  it.effect("a session without a DPoP key gets a ticket without one", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const row = yield* gateway.sessions.issue({
        subject: "owner",
        method: "browser-session-cookie",
        scopes: GATEWAY_SCOPES,
        client: { label: "plain", deviceType: "desktop" },
      });
      const result = yield* issueTicket({ sessionId: row.sessionId });
      const verified = yield* gateway.sessions.verifyWebSocketToken(Redacted.value(result.ticket));
      assert.equal(verified.proofKeyThumbprint, undefined);
    }).pipe(Effect.provide(layerGateway)),
  );

  const renewable = {
    subject: "device",
    method: "dpop-access-token",
    scopes: GATEWAY_SCOPES,
    proofKeyThumbprint: "renewing-key",
    ttl: Duration.hours(1),
    client: { label: "rpc", deviceType: "desktop" },
  } as const;

  it.effect("binds the ticket to the renewal once the socket's own session has expired", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const original = yield* gateway.sessions.issue(renewable);
      yield* TestClock.adjust(Duration.minutes(59));
      const renewal = yield* gateway.sessions.issue(renewable);
      yield* TestClock.adjust(Duration.minutes(2));
      const result = yield* issueTicket({
        sessionId: original.sessionId,
        proofKeyThumbprint: "renewing-key",
      });
      const verified = yield* gateway.sessions.verifyWebSocketToken(Redacted.value(result.ticket));
      assert.equal(verified.sessionId, renewal.sessionId);
      assert.equal(verified.proofKeyThumbprint, "renewing-key");
    }).pipe(
      Effect.provideService(GatewayAvailabilityOverride, { available: true }),
      Effect.provide(layerGateway),
    ),
  );

  it.effect.each([
    { name: "no renewal", renewal: null },
    { name: "a renewal for another key", renewal: { proofKeyThumbprint: "other-key" } },
    { name: "a renewal with fewer scopes", renewal: { scopes: [GATEWAY_SCOPES[0]!] } },
    { name: "a renewal that was revoked", renewal: {}, revoke: true },
  ] as const)("refuses instead of minting a dead ticket after $name", (testCase) =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const original = yield* gateway.sessions.issue(renewable);
      yield* TestClock.adjust(Duration.minutes(59));
      if (testCase.renewal !== null) {
        const renewal = yield* gateway.sessions.issue({ ...renewable, ...testCase.renewal });
        if ("revoke" in testCase) yield* gateway.sessions.revoke(renewal.sessionId);
      }
      yield* TestClock.adjust(Duration.minutes(2));
      const error = yield* issueTicket({
        sessionId: original.sessionId,
        proofKeyThumbprint: "renewing-key",
      }).pipe(Effect.flip);
      assert.instanceOf(error, EnvironmentAuthorizationError);
    }).pipe(
      Effect.provideService(GatewayAvailabilityOverride, { available: true }),
      Effect.provide(layerGateway),
    ),
  );

  it.effect.each(["discovery-disabled", "unsupported-platform"] as const)(
    "refuses with %s",
    (reason) =>
      Effect.gen(function* () {
        const error = yield* issueTicket({ sessionId: AuthSessionId.make("s") }).pipe(Effect.flip);
        assert.instanceOf(error, LoopbackGatewayUnavailableError);
        assert.equal(error.reason, reason);
      }).pipe(
        Effect.provideService(GatewayAvailabilityOverride, { available: false, reason }),
        Effect.provide(layerGateway),
      ),
  );

  it.effect("allows 30 tickets a minute per session and then answers rate-limited", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const row = yield* gateway.sessions.issue({
        subject: "owner",
        method: "browser-session-cookie",
        scopes: GATEWAY_SCOPES,
        client: { label: "rate", deviceType: "desktop" },
      });
      for (let i = 0; i < 30; i++) yield* issueTicket({ sessionId: row.sessionId });
      const error = yield* issueTicket({ sessionId: row.sessionId }).pipe(Effect.flip);
      assert.instanceOf(error, LoopbackGatewayUnavailableError);
      assert.equal(error.reason, "rate-limited");
      yield* TestClock.adjust(Duration.seconds(61));
      yield* issueTicket({ sessionId: row.sessionId });
    }).pipe(
      Effect.provideService(GatewayAvailabilityOverride, { available: true }),
      Effect.provideService(GatewayLimits, makeGatewayLimits()),
      Effect.provide(layerGateway),
    ),
  );
});

describe("the allowed-ports RPCs", () => {
  it.effect("list, allow and remove answer with the whole list each time", () =>
    Effect.gen(function* () {
      const handlers = yield* makeLoopbackGatewayRpcHandlers({
        sessionId: AuthSessionId.make("s"),
      });
      const M = FORK_LOOPBACK_GATEWAY_WS_METHODS;
      assert.deepEqual(yield* handlers[M.listAllowedPorts](), { ports: [] });
      yield* handlers[M.allowPort]({ port: 7733 });
      const both = yield* handlers[M.allowPort]({ port: 8080 });
      assert.deepEqual(
        both.ports.map((entry) => entry.port),
        [7733, 8080],
      );
      const left = yield* handlers[M.removeAllowedPort]({ port: 7733 });
      assert.deepEqual(
        left.ports.map((entry) => entry.port),
        [8080],
      );
      assert.deepEqual(yield* handlers[M.listAllowedPorts](), left);
    }).pipe(
      Effect.provideService(LoopbackGatewayGrants, memoryGrants()),
      Effect.provide(layerGateway),
    ),
  );
});
