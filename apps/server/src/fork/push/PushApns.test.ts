// @effect-diagnostics nodeBuiltinImport:off -- The test checks the JWT signature with node:crypto.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type PushNotificationKind,
  type PushNotificationPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { ApnsConfig } from "./apnsConfig.ts";
import { APNS_TOKEN_REUSE_SECONDS } from "./apnsJwt.ts";
import { buildApnsRequestBody, fillAlertTemplate } from "./apnsPayload.ts";
import * as ApnsTransport from "./apnsTransport.ts";
import * as PushApns from "./PushApns.ts";
import type { StoredApnsPushRegistration } from "./PushRegistrations.ts";

const NOW = "2026-11-02T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const NOW_SECONDS = NOW_MS / 1000;
const keys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config: ApnsConfig = {
  status: "configured",
  credentials: { keyId: "ABC123DEFG", teamId: "TEAM123456", privateKey: keys.privateKey },
};

const registration: StoredApnsPushRegistration = {
  kind: "apns",
  sessionId: AuthSessionId.make("session-1"),
  deviceId: "device-1",
  label: "iPhone",
  environmentLabel: "Mac mini",
  deviceToken: "ab".repeat(32),
  apsEnvironment: "production",
  bundleId: "com.example.app",
  preferences: {
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  createdAt: NOW,
  updatedAt: NOW,
  lastDelivery: null,
};

const payloadFor = (
  kind: PushNotificationKind,
  overrides: Partial<PushNotificationPayload> = {},
): PushNotificationPayload => ({
  v: 1,
  id: "alert-1",
  kind,
  environmentId: "env 1",
  environmentLabel: "Mac mini",
  threadId: "thread/1",
  threadTitle: "Fix the build",
  projectTitle: "Web app",
  at: NOW_MS,
  ...overrides,
});

type Sent = Parameters<ApnsTransport.ApnsTransport["Service"]["send"]>[0];

const makeHarness = Effect.fnUntraced(function* (
  respond: (attempt: number) => { status: number; reason: string | null } | null = () => ({
    status: 200,
    reason: null,
  }),
) {
  yield* TestClock.setTime(NOW_MS);
  const sent: Sent[] = [];
  const transport = ApnsTransport.ApnsTransport.of({
    send: (input) =>
      Effect.suspend(() => {
        sent.push(input);
        const response = respond(sent.length);
        return response === null
          ? Effect.fail(new ApnsTransport.ApnsTransportError({}))
          : Effect.succeed(response);
      }),
  });
  const apns = yield* PushApns.make(config).pipe(
    Effect.provideService(ApnsTransport.ApnsTransport, transport),
  );
  return { apns, sent };
});

const jwtOf = (sent: Sent) => (sent.headers.authorization ?? "").replace(/^bearer /, "");
const decodePart = (part: string | undefined) =>
  JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as Record<string, unknown>;

describe("APNs provider token", () => {
  it.effect("is an ES256 JWT with the key id and team id that the key really signed", () =>
    Effect.gen(function* () {
      const { apns, sent } = yield* makeHarness();
      yield* apns.send({ registration, payload: payloadFor("approval") });
      const [header, claims, signature] = jwtOf(sent[0]!).split(".");
      assert.deepStrictEqual(decodePart(header), { alg: "ES256", kid: "ABC123DEFG" });
      assert.deepStrictEqual(decodePart(claims), { iss: "TEAM123456", iat: NOW_SECONDS });
      assert.equal(
        NodeCrypto.verify(
          "sha256",
          Buffer.from(`${header}.${claims}`),
          { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature ?? "", "base64url"),
        ),
        true,
      );
    }),
  );

  it.effect("is reused until it is nearly old enough to be refused, then renewed", () =>
    Effect.gen(function* () {
      const { apns, sent } = yield* makeHarness();
      const push = apns.send({ registration, payload: payloadFor("completed") });
      yield* push;
      yield* TestClock.adjust("10 minutes");
      yield* push;
      assert.equal(jwtOf(sent[1]!), jwtOf(sent[0]!));

      // Apple refuses tokens renewed more often than every 20 minutes and older than 60.
      yield* TestClock.adjust(`${APNS_TOKEN_REUSE_SECONDS / 60} minutes`);
      yield* push;
      assert.notEqual(jwtOf(sent[2]!), jwtOf(sent[0]!));
      const iat = decodePart(jwtOf(sent[2]!).split(".")[1])["iat"];
      assert.equal(iat, NOW_SECONDS + 10 * 60 + APNS_TOKEN_REUSE_SECONDS);
    }),
  );

  it.effect("is signed again after Apple says it expired", () =>
    Effect.gen(function* () {
      const { apns, sent } = yield* makeHarness((attempt) =>
        attempt === 1
          ? { status: 403, reason: "ExpiredProviderToken" }
          : { status: 200, reason: null },
      );
      const push = apns.send({ registration, payload: payloadFor("failed") });
      assert.equal((yield* push).outcome, "rejected");
      yield* TestClock.adjust("1 second");
      assert.equal((yield* push).outcome, "delivered");
      assert.notEqual(jwtOf(sent[1]!), jwtOf(sent[0]!));
    }),
  );
});

describe("APNs delivery", () => {
  it.effect(
    "addresses the phone's own host, topic and token, and carries the thread for taps",
    () =>
      Effect.gen(function* () {
        const { apns, sent } = yield* makeHarness();
        yield* apns.send({
          registration: { ...registration, apsEnvironment: "development" },
          payload: payloadFor("approval"),
        });
        const request = sent[0]!;
        assert.equal(request.apsEnvironment, "development");
        assert.equal(request.deviceToken, registration.deviceToken);
        assert.equal(request.headers["apns-topic"], "com.example.app");
        assert.equal(request.headers["apns-push-type"], "alert");
        assert.equal(request.headers["apns-collapse-id"], "alert-1");
        const body = JSON.parse(request.body);
        assert.deepStrictEqual(body.aps.alert, {
          title: "Fix the build",
          body: "Approval needed · Web app · Mac mini",
        });
        // The same field names the official relay's pushes use, which the tap handler reads.
        assert.deepStrictEqual(body.body, {
          environmentId: "env 1",
          threadId: "thread/1",
          deepLink: "/threads/env%201/thread%2F1",
        });
        assert.notInclude(request.body, registration.deviceToken);
      }),
  );

  it.effect.each([
    { status: 200, reason: null, outcome: "delivered" },
    { status: 410, reason: null, outcome: "gone" },
    { status: 400, reason: "BadDeviceToken", outcome: "gone" },
    { status: 400, reason: "Unregistered", outcome: "gone" },
    { status: 400, reason: "PayloadEmpty", outcome: "rejected" },
    { status: 403, reason: "InvalidProviderToken", outcome: "rejected" },
    { status: 429, reason: "TooManyRequests", outcome: "rejected" },
    { status: 500, reason: null, outcome: "rejected" },
  ] as const)("answers $status $reason as $outcome", ({ status, reason, outcome }) =>
    Effect.gen(function* () {
      const { apns } = yield* makeHarness(() => ({ status, reason }));
      const result = yield* apns.send({ registration, payload: payloadFor("failed") });
      assert.deepStrictEqual(result, { outcome, status });
    }),
  );

  it.effect("calls a connection that failed unreachable", () =>
    Effect.gen(function* () {
      const { apns } = yield* makeHarness(() => null);
      const result = yield* apns.send({ registration, payload: payloadFor("failed") });
      assert.deepStrictEqual(result, { outcome: "unreachable", status: null });
    }),
  );
});

describe("APNs alert text", () => {
  const templates = {
    completed: { title: "{project} — {thread}", body: "已完成 · {environment}" },
  };

  it("fills the templates the phone sent, and falls back to English for the rest", () => {
    const completed = buildApnsRequestBody({ payload: payloadFor("completed"), templates });
    assert.deepStrictEqual(completed.aps.alert, {
      title: "Web app — Fix the build",
      body: "已完成 · Mac mini",
    });
    const failed = buildApnsRequestBody({ payload: payloadFor("failed"), templates });
    assert.equal(failed.aps.alert.body, "Failed · Web app · Mac mini");
    assert.equal(
      buildApnsRequestBody({ payload: payloadFor("failed"), templates: undefined }).aps.alert.body,
      "Failed · Web app · Mac mini",
    );
  });

  it("does not fill a placeholder that a thread title happens to contain", () => {
    assert.equal(
      fillAlertTemplate("{thread} / {project}", {
        thread: "about {project}",
        project: "P",
        environment: "E",
      }),
      "about {project} / P",
    );
  });

  it("sends a test alert without a thread to open", () => {
    const body = buildApnsRequestBody({
      payload: payloadFor("test", { threadId: "", threadTitle: "", projectTitle: "" }),
      templates: undefined,
    });
    assert.equal(body.body, undefined);
    assert.equal(body.aps["thread-id"], "t3-agent-alerts");
    assert.equal(body.aps.alert.body, "Notifications from Mac mini reach this phone.");
  });
});
