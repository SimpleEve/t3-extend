import { T3X_DEVICE_TOKEN_PATH } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  COMPUTER_URL,
  DEVICE_ID,
  ENVIRONMENT_ID,
  OTHER_ENVIRONMENT_ID,
  THUMBPRINT,
  accessTokenJson,
  computer,
  deviceEntry,
  makeRig,
  rejectedPass,
  route,
  view,
} from "./deviceAuthorization.testkit.ts";
import { DEVICE_UNKNOWN_RETRY_DELAYS_MS } from "./liveAuthorization.ts";

const passPaths = (requests: ReadonlyArray<{ readonly url: string }>) =>
  requests.map((request) => new URL(request.url).pathname);

describe("device authorization: what is checked before a pass is sent", () => {
  it.effect("asks the registry's list, then the computer's well-known, then sends the pass", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      const prepared = yield* rig.authorization.prepare(route());
      expect(passPaths(rig.requests)).toEqual([
        "/.well-known/t3/environment",
        T3X_DEVICE_TOKEN_PATH,
        "/api/auth/websocket-ticket/rpc",
      ]);
      expect(prepared.environmentId).toBe(ENVIRONMENT_ID);
      expect(prepared.httpAuthorization._tag).toBe("Dpop");
      expect(prepared.socketUrl).toContain("connectionMethod=direct");
      expect(prepared.socketUrl).not.toContain("relay");
      // The pass is for this computer and this client's session key, and the request is DPoP-signed.
      expect(yield* Ref.get(rig.signed)).toEqual([{ audience: ENVIRONMENT_ID, jkt: THUMBPRINT }]);
      expect(rig.passRequests()[0]!.headers.get("dpop")).toBe(
        `proof:POST:${COMPUTER_URL}${T3X_DEVICE_TOKEN_PATH}`,
      );
      for (const request of rig.requests) {
        expect(new URL(request.url).origin).toBe(COMPUTER_URL);
        expect(request.headers.get("authorization")?.startsWith("Bearer")).not.toBe(true);
      }
    }),
  );

  const REFUSED_URLS: ReadonlyArray<readonly [string, string]> = [
    ["http instead of https", "http://mac.t3.example.test"],
    ["credentials in the address", "https://user:pw@mac.t3.example.test"],
    ["a path", "https://mac.t3.example.test/x"],
    ["a query", "https://mac.t3.example.test/?a=1"],
    ["another port", "https://mac.t3.example.test:8443"],
    ["a host outside the registry's domain", "https://mac.evil.test"],
    ["a two-level subdomain", "https://a.b.t3.example.test"],
    ["the registry's own host", "https://t3.example.test"],
    ["a lookalike suffix", "https://mac-t3.example.test"],
  ];
  it.effect.each(REFUSED_URLS)("sends nothing to an address with %s", ([, url]) =>
    Effect.gen(function* () {
      const rig = yield* makeRig({ view: view([computer({ url })]) });
      const error = yield* rig.authorization.prepare(route(url)).pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(rig.requests).toEqual([]);
      expect(yield* Ref.get(rig.signed)).toEqual([]);
    }),
  );

  it.effect("does not send a pass when the computer answers with another environment id", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({ descriptorEnvironmentId: OTHER_ENVIRONMENT_ID });
      const error = yield* rig.authorization.prepare(route()).pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(passPaths(rig.requests)).toEqual(["/.well-known/t3/environment"]);
      expect(yield* Ref.get(rig.signed)).toEqual([]);
    }),
  );

  it.effect("waits, without a request, for a computer the registry has no environment id for", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({ view: view([computer({ environmentId: null })]) });
      const error = yield* rig.authorization.prepare(route()).pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionTransientError");
      expect(rig.requests).toEqual([]);
    }),
  );

  it.effect("blocks a registry record that names another environment", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({
        view: view([computer({ environmentId: OTHER_ENVIRONMENT_ID })]),
      });
      const error = yield* rig.authorization.prepare(route()).pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(rig.requests).toEqual([]);
    }),
  );

  it.effect("blocks a computer that is no longer in the list, or is this computer itself", () =>
    Effect.gen(function* () {
      for (const computers of [[], [computer({ self: true })]]) {
        const rig = yield* makeRig({ view: view(computers) });
        const error = yield* rig.authorization.prepare(route()).pipe(Effect.flip);
        expect(error._tag).toBe("ConnectionBlockedError");
        expect(rig.requests).toEqual([]);
      }
    }),
  );

  it.effect("retries, rather than blocks, until the server's list arrives, then connects", () =>
    Effect.gen(function* () {
      // A saved computer starts connecting after a restart before its own server pushed the list.
      const rig = yield* makeRig({ listNotReady: true });
      const early = yield* rig.authorization.prepare(route()).pipe(Effect.flip);
      expect(early._tag).toBe("ConnectionTransientError");
      expect(rig.requests).toEqual([]);
      yield* Ref.set(rig.listReady, true);
      const prepared = yield* rig.authorization.prepare(route());
      expect(prepared.httpBaseUrl).toBe(COMPUTER_URL);
    }),
  );

  it.effect("blocks an environment the sync does not manage", () =>
    Effect.gen(function* () {
      const notDevices = [
        new Map(),
        // Saved as a learned route, not by the sync.
        new Map([[ENVIRONMENT_ID, deviceEntry(DEVICE_ID, ENVIRONMENT_ID, { learned: true })]]),
      ];
      for (const directory of notDevices) {
        const rig = yield* makeRig();
        yield* SubscriptionRef.set(rig.directory, directory);
        const error = yield* rig.authorization.prepare(route()).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ConnectionBlockedError",
          detail: "This environment is not managed by your server.",
        });
        expect(rig.requests).toEqual([]);
      }
    }),
  );

  it.effect("accepts an address the computer advertised and refuses a stale registry one", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      const lan = yield* rig.authorization.prepare(route("http://192.168.1.5:3773"));
      expect(lan.httpBaseUrl).toBe("http://192.168.1.5:3773");
      // Another host under the registry's domain is not the address the registry lists.
      const before = rig.requests.length;
      const stale = yield* rig.authorization
        .prepare(route("https://old.t3.example.test"))
        .pipe(Effect.flip);
      expect(stale._tag).toBe("ConnectionBlockedError");
      expect(rig.requests).toHaveLength(before);
    }),
  );

  it.effect("learns the environment id from the computer when the list carries none", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({ view: view([computer({ environmentId: null })], false) });
      const prepared = yield* rig.authorization.prepare(route());
      expect(prepared.environmentId).toBe(ENVIRONMENT_ID);
      expect(yield* Ref.get(rig.signed)).toHaveLength(1);
    }),
  );
});

describe("device authorization: the pass exchange", () => {
  const REJECTIONS: ReadonlyArray<{
    readonly reason: string;
    readonly status?: number;
    readonly tag: string;
    readonly blockedReason?: string;
    readonly failureCause?: string;
  }> = [
    { reason: "device_revoked", tag: "ConnectionBlockedError", blockedReason: "authentication" },
    { reason: "device_hidden", tag: "ConnectionBlockedError", blockedReason: "authentication" },
    {
      reason: "time_window",
      tag: "ConnectionBlockedError",
      blockedReason: "authentication",
      failureCause: "clock_skew",
    },
    { reason: "audience_mismatch", tag: "ConnectionBlockedError", blockedReason: "authentication" },
    { reason: "registry_mismatch", tag: "ConnectionBlockedError", blockedReason: "authentication" },
    { reason: "key_mismatch", tag: "ConnectionBlockedError", blockedReason: "authentication" },
    { reason: "expired", tag: "ConnectionTransientError" },
    { reason: "replay", tag: "ConnectionTransientError" },
    { reason: "list_expired", status: 503, tag: "ConnectionTransientError" },
    { reason: "list_unavailable", status: 503, tag: "ConnectionTransientError" },
    { reason: "rate_limited", status: 429, tag: "ConnectionTransientError" },
  ];
  it.effect.each(REJECTIONS)("maps $reason and does not retry it", (rejection) =>
    Effect.gen(function* () {
      const rig = yield* makeRig({
        passReplies: [rejectedPass(rejection.reason, rejection.status ?? 401)],
      });
      const error = yield* rig.authorization.prepare(route()).pipe(Effect.flip);
      expect(error._tag).toBe(rejection.tag);
      if (error._tag === "ConnectionBlockedError") {
        expect(error.reason).toBe(rejection.blockedReason);
        expect(error.failureCause).toBe(rejection.failureCause);
      }
      // Nothing here ever names the relay.
      expect(error).toMatchObject({ hop: expect.not.stringMatching(/relay/) });
      expect(rig.passRequests()).toHaveLength(1);
      expect(rig.waits).toEqual([]);
      // Only a refusal that may mean "removed" is worth asking the registry about.
      expect(rig.refusals()).toBe(rejection.reason === "device_revoked" ? 1 : 0);
    }),
  );

  it.effect("tells a computer's own choice not to be seen apart from a removal", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({ passReplies: [rejectedPass("device_hidden")] });
      const error = yield* rig.authorization.prepare(route()).pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(error).toMatchObject({ detail: "That computer is not available to this device." });
      expect(error).not.toMatchObject({ detail: expect.stringContaining("removed") });
      // Neither retried nor reported as a suspected removal.
      expect(rig.passRequests()).toHaveLength(1);
      expect(rig.waits).toEqual([]);
      expect(rig.refusals()).toBe(0);
    }),
  );

  it.effect("shows device_unknown as waiting, retries with backoff, then signs in", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({
        passReplies: [rejectedPass("device_unknown"), rejectedPass("device_unknown")],
      });
      const prepare = yield* Effect.forkChild(rig.authorization.prepare(route()));
      expect(yield* Queue.take(rig.passAttempts)).toBe(1);
      yield* TestClock.adjust(1_000);
      expect(yield* Queue.take(rig.passAttempts)).toBe(2);
      expect(rig.wait.snapshot().has(ENVIRONMENT_ID)).toBe(true);
      yield* TestClock.adjust(2_000);
      expect(yield* Queue.take(rig.passAttempts)).toBe(3);
      const prepared = yield* Fiber.join(prepare);
      expect(prepared.httpAuthorization._tag).toBe("Dpop");
      expect(rig.wait.snapshot().size).toBe(0);
      // Each attempt gets a fresh pass, but the registry is asked once, at the first refusal.
      expect(yield* Ref.get(rig.signed)).toHaveLength(3);
      expect(rig.refusals()).toBe(1);
    }),
  );

  it.effect("gives up after about 75 seconds and says so", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({
        passReplies: Array.from({ length: 10 }, () => rejectedPass("device_unknown")),
      });
      const prepare = yield* Effect.forkChild(rig.authorization.prepare(route()).pipe(Effect.flip));
      const delays = DEVICE_UNKNOWN_RETRY_DELAYS_MS;
      yield* Queue.take(rig.passAttempts);
      for (const delay of delays) {
        yield* TestClock.adjust(delay);
        yield* Queue.take(rig.passAttempts);
      }
      const error = yield* Fiber.join(prepare);
      expect(error._tag).toBe("ConnectionBlockedError");
      expect(delays.reduce((total, delay) => total + delay, 0)).toBeGreaterThanOrEqual(70_000);
      expect(rig.passRequests()).toHaveLength(delays.length + 1);
      expect(rig.wait.snapshot().size).toBe(0);
    }),
  );

  it.effect("reuses a session and drops it when the computer is forgotten", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      const first = yield* rig.authorization.prepare(route());
      const second = yield* rig.authorization.prepare(route());
      expect(second.httpAuthorization).toEqual(first.httpAuthorization);
      expect(rig.passRequests()).toHaveLength(1);
      // The computer is still asked who it is every time, before the cached token is used.
      expect(
        rig.requests.filter((request) => request.url.endsWith("/.well-known/t3/environment")),
      ).toHaveLength(2);

      yield* rig.authorization.forget(ENVIRONMENT_ID);
      yield* rig.authorization.prepare(route());
      expect(rig.passRequests()).toHaveLength(2);
    }),
  );

  it.effect("signs HTTP requests with the cached session and renews a rejected one", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      const prepared = yield* rig.authorization.prepare(route());
      const http = yield* rig.authorization.authorizeHttp({
        expectedEnvironmentId: ENVIRONMENT_ID,
        httpBaseUrl: COMPUTER_URL,
      });
      expect(http.httpAuthorization).toEqual(prepared.httpAuthorization);
      expect(rig.passRequests()).toHaveLength(1);
      const renewed = yield* rig.authorization.authorizeHttp({
        expectedEnvironmentId: ENVIRONMENT_ID,
        httpBaseUrl: COMPUTER_URL,
        rejectedAccessToken: http.httpAuthorization.accessToken,
      });
      expect(renewed.httpAuthorization.accessToken).not.toBe(http.httpAuthorization.accessToken);
      expect(rig.passRequests()).toHaveLength(2);
    }),
  );

  it.effect("renews a live session about a minute before it expires", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig();
      const prepared = yield* rig.authorization.prepare(route());
      if (prepared.httpAuthorization._tag !== "Dpop") return;
      const renewal = yield* Effect.forkChild(
        rig.authorization.renew({
          expectedEnvironmentId: ENVIRONMENT_ID,
          expiresAtEpochMs: prepared.httpAuthorization.expiresAtEpochMs,
        }),
      );
      expect(rig.passRequests()).toHaveLength(1);
      yield* TestClock.adjust(3_539_000);
      expect(rig.passRequests()).toHaveLength(1);
      yield* TestClock.adjust(2_000);
      expect(yield* Queue.take(rig.passAttempts)).toBe(1);
      expect(yield* Queue.take(rig.passAttempts)).toBe(2);
      yield* Fiber.interrupt(renewal);
    }),
  );

  it.effect("ends renewal with a block when the computer refuses the device", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({
        passReplies: [Response.json(accessTokenJson("token-1")), rejectedPass("device_revoked")],
      });
      const prepared = yield* rig.authorization.prepare(route());
      if (prepared.httpAuthorization._tag !== "Dpop") return;
      const renewal = yield* Effect.forkChild(
        rig.authorization
          .renew({
            expectedEnvironmentId: ENVIRONMENT_ID,
            expiresAtEpochMs: prepared.httpAuthorization.expiresAtEpochMs,
          })
          .pipe(Effect.flip),
      );
      yield* TestClock.adjust(3_541_000);
      yield* Queue.take(rig.passAttempts);
      yield* Queue.take(rig.passAttempts);
      const error = yield* Fiber.join(renewal);
      expect(error._tag).toBe("ConnectionBlockedError");
    }),
  );
});

describe("device authorization: nothing falls back", () => {
  it.effect("sends no bearer token and talks to no host but the computer's", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig({ passReplies: [rejectedPass("device_revoked")] });
      yield* rig.authorization.prepare(route()).pipe(Effect.flip);
      expect(rig.requests.length).toBeGreaterThan(0);
      for (const request of rig.requests) {
        expect(new URL(request.url).origin).toBe(COMPUTER_URL);
        expect(request.headers.get("authorization")).toBeNull();
      }
    }),
  );
});
