import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import {
  makeAntigravityAccountPool,
  type AntigravityAccount,
  type AntigravityProbeOutcome,
} from "./antigravityAccountPool.ts";
import {
  ANTIGRAVITY_BACKGROUND_PROBE_BACKOFF_CAP_MS,
  ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS,
  ANTIGRAVITY_BACKGROUND_PROBE_START_DELAY_MS,
  ANTIGRAVITY_BACKGROUND_PROBE_TICK_MS,
  makeAntigravityAccountProber,
  makeAntigravityAccountReader,
  nextAntigravityProbeAt,
  pickNextAntigravityProbe,
  startAntigravityBackgroundProbe,
  type AntigravityAccountProber,
} from "./antigravityBackgroundProbe.ts";

const MINUTE = 60_000;
const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const instanceId = ProviderInstanceId.make("antigravity-test");

const token = (email: string, accessToken = `access-${email}`) =>
  JSON.stringify({
    token: {
      access_token: accessToken,
      refresh_token: `refresh-${email}`,
      expiry: "2099-01-01T00:00:00Z",
    },
    id_token_email: email,
  });
const emailOf = (text: string): string => JSON.parse(text).id_token_email;

const reading = (usedPercent = 10): ServerProviderUsageLimits => ({
  checkedAt: "1970-01-01T00:00:00.000Z",
  windows: [{ id: "gemini-5h", kind: "session", label: "Gemini · 5-hour", usedPercent }],
});

const account = (
  id: string,
  overrides: Partial<AntigravityAccount> & { readonly probe?: AntigravityAccount["probe"] } = {},
): AntigravityAccount => ({
  id,
  email: `${id}@example.com`,
  current: false,
  exhaustedUntil: null,
  usageLimits: null,
  probe: { lastAttemptAt: null, failures: 0, failure: null },
  ...overrides,
});

describe("when an account is next read", () => {
  it("is due at once when it was never read, and an interval after a reading", () => {
    expect(nextAntigravityProbeAt(account("a"))).toBe(0);
    expect(
      nextAntigravityProbeAt(
        account("a", { probe: { lastAttemptAt: 10 * MINUTE, failures: 0, failure: null } }),
      ),
    ).toBe(10 * MINUTE + ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS);
    // A reading taken while the account was in use counts as a read.
    expect(
      nextAntigravityProbeAt(
        account("a", {
          usageLimits: {
            ...reading(),
            checkedAt: DateTime.formatIso(DateTime.makeUnsafe(20 * MINUTE)),
          },
        }),
      ),
    ).toBe(20 * MINUTE + ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS);
  });

  it("doubles the wait after each failure up to a cap, and waits the cap for a dead sign-in", () => {
    const failed = (failures: number, reason: "failed" | "expired") =>
      nextAntigravityProbeAt(
        account("a", {
          probe: { lastAttemptAt: 0, failures, failure: { at: 0, reason } },
        }),
      );
    expect(failed(1, "failed")).toBe(ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS);
    expect(failed(2, "failed")).toBe(2 * ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS);
    expect(failed(3, "failed")).toBe(4 * ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS);
    expect(failed(20, "failed")).toBe(ANTIGRAVITY_BACKGROUND_PROBE_BACKOFF_CAP_MS);
    expect(failed(1, "expired")).toBe(ANTIGRAVITY_BACKGROUND_PROBE_BACKOFF_CAP_MS);
  });

  it("picks the most overdue account that is not in use, in pool order on a tie", () => {
    const due = (id: string, lastAttemptAt: number) =>
      account(id, { probe: { lastAttemptAt, failures: 0, failure: null } });
    const now = 10 * ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS;
    expect(
      pickNextAntigravityProbe(
        [
          account("cur", { current: true }),
          due("a", 5 * MINUTE),
          due("b", MINUTE),
          due("c", MINUTE),
        ],
        now,
      ),
    ).toBe("b");
    // Nothing is due yet, and the current account is never picked however stale it is.
    expect(
      pickNextAntigravityProbe([account("cur", { current: true }), due("a", now - MINUTE)], now),
    ).toBeUndefined();
  });
});

/**
 * The pool's scheduling surface in memory. The clock tests use it because a real pool does file I/O
 * that finishes outside the test clock, so a tick could register its next sleep after the test has
 * already moved on. The real pool's behaviour has its own tests.
 */
const memoryPool = () => {
  const accounts = new Map<string, AntigravityAccount>(
    ["a", "b", "c"].map((id) => [id, account(id, { current: id === "b", usageLimits: null })]),
  );
  const lent = new Set<string>();
  const pool = {
    list: Effect.sync(() => [...accounts.values()]),
    beginProbe: (id: string) =>
      Effect.sync(() => {
        const found = accounts.get(id);
        if (found === undefined || found.current || lent.has(id)) return undefined;
        lent.add(id);
        return { id, token: token(`${id}@example.com`) };
      }),
    finishProbe: (lease: { readonly id: string }, outcome: AntigravityProbeOutcome) =>
      Effect.gen(function* () {
        lent.delete(lease.id);
        const now = yield* Clock.currentTimeMillis;
        const found = accounts.get(lease.id)!;
        accounts.set(
          lease.id,
          outcome._tag === "Read"
            ? {
                ...found,
                usageLimits: outcome.limits,
                probe: { lastAttemptAt: now, failures: 0, failure: null },
              }
            : {
                ...found,
                probe: {
                  lastAttemptAt: now,
                  failures: found.probe.failures + 1,
                  failure: {
                    at: now,
                    reason: outcome._tag === "Failed" ? outcome.reason : "failed",
                  },
                },
              },
        );
        return "saved" as const;
      }),
  };
  return { pool, accounts };
};

const scheduleHarness = Effect.fn("AntigravityBackgroundProbeTest.scheduleHarness")(function* (
  options: {
    readonly outcome?: (email: string, reads: number) => AntigravityProbeOutcome | "hang";
  } = {},
) {
  const { pool, accounts } = memoryPool();
  const reads: Array<string> = [];
  const read = (text: string): Effect.Effect<AntigravityProbeOutcome> => {
    const email = emailOf(text);
    reads.push(email);
    const outcome = options.outcome?.(email, reads.filter((entry) => entry === email).length);
    return outcome === "hang"
      ? Effect.never
      : Effect.succeed(outcome ?? { _tag: "Read", token: text, limits: reading() });
  };
  let probed = 0;
  const prober = yield* makeAntigravityAccountProber({
    instanceId,
    pool,
    read,
    onProbed: Effect.sync(() => {
      probed++;
    }),
  });
  return { pool, accounts, prober, reads, probed: () => probed };
});

/** Three saved accounts, `b` in use; the reader is a fake that records what it was asked to read. */
const harness = Effect.fn("AntigravityBackgroundProbeTest.harness")(function* (
  options: {
    readonly outcome?: (email: string, reads: number) => AntigravityProbeOutcome | "hang";
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const profile = yield* fs.makeTempDirectoryScoped();
  const pool = yield* makeAntigravityAccountPool(profile);
  const currentPath = `${profile}/antigravity-acp/antigravity-oauth-token`;
  yield* fs.makeDirectory(`${profile}/antigravity-acp`, { recursive: true });
  for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
    yield* pool.beginAdd;
    yield* fs.writeFileString(currentPath, token(email));
    yield* pool.settleAdd;
  }
  const [a, b, c] = yield* pool.list;
  yield* pool.select(b!.id);
  const reads: Array<string> = [];
  let probed = 0;
  const read = (text: string): Effect.Effect<AntigravityProbeOutcome> => {
    const email = emailOf(text);
    reads.push(email);
    const outcome = options.outcome?.(email, reads.filter((entry) => entry === email).length);
    return outcome === "hang"
      ? Effect.never
      : Effect.succeed(outcome ?? { _tag: "Read", token: text, limits: reading() });
  };
  const prober = yield* makeAntigravityAccountProber({
    instanceId,
    pool,
    read,
    onProbed: Effect.sync(() => {
      probed++;
    }),
  });
  return { pool, prober, reads, probed: () => probed, a: a!, b: b!, c: c! };
});

describe("the background reader's schedule", () => {
  const start = (prober: AntigravityAccountProber, settings = { backgroundAccountCheck: true }) =>
    startAntigravityBackgroundProbe({ enabled: true, settings, prober });

  it.effect("waits for startup, then reads one account that is not in use per tick", () =>
    Effect.gen(function* () {
      const { prober, reads, probed } = yield* scheduleHarness();
      yield* start(prober);
      yield* TestClock.adjust(ANTIGRAVITY_BACKGROUND_PROBE_START_DELAY_MS - 1);
      expect(reads).toEqual([]);
      // Two accounts are due, but only one is read at a time.
      yield* TestClock.adjust(1);
      expect(reads).toEqual(["a@example.com"]);
      yield* TestClock.adjust(ANTIGRAVITY_BACKGROUND_PROBE_TICK_MS);
      expect(reads).toEqual(["a@example.com", "c@example.com"]);
      expect(probed()).toBe(2);
      // Nothing is due for a while, and then round-robin starts again; b is never read.
      yield* TestClock.adjust(ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS - 2 * MINUTE);
      expect(reads).toHaveLength(2);
      yield* TestClock.adjust(MINUTE);
      expect(reads.slice(2)).toEqual(["a@example.com"]);
      yield* TestClock.adjust(MINUTE);
      expect(reads.slice(2)).toEqual(["a@example.com", "c@example.com"]);
      expect(reads).not.toContain("b@example.com");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "does not read in the background when the setting is off or the instance is disabled",
    () =>
      Effect.gen(function* () {
        const off = yield* scheduleHarness();
        yield* start(off.prober, { backgroundAccountCheck: false });
        const disabled = yield* scheduleHarness();
        yield* startAntigravityBackgroundProbe({
          enabled: false,
          settings: { backgroundAccountCheck: true },
          prober: disabled.prober,
        });
        yield* TestClock.adjust(12 * 60 * MINUTE);
        expect(off.reads).toEqual([]);
        expect(disabled.reads).toEqual([]);
        // A manual refresh still works with the setting off.
        yield* off.prober.refresh("a");
        expect(off.reads).toEqual(["a@example.com"]);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps the old reading on a failure and backs off instead of retrying", () =>
    Effect.gen(function* () {
      const { accounts, prober, reads } = yield* scheduleHarness({
        outcome: (email, count) =>
          email === "a@example.com"
            ? count === 1
              ? { _tag: "Read", token: token(email), limits: reading(33) }
              : { _tag: "Failed", reason: "failed" }
            : { _tag: "Failed", reason: "timeout" },
      });
      yield* start(prober);
      yield* TestClock.adjust(ANTIGRAVITY_BACKGROUND_PROBE_START_DELAY_MS);
      yield* TestClock.adjust(ANTIGRAVITY_BACKGROUND_PROBE_TICK_MS);
      expect(reads).toEqual(["a@example.com", "c@example.com"]);
      const readsOf = (email: string) => reads.filter((entry) => entry === email).length;
      // c failed once: it waits one interval from its attempt (at 4 min), not one tick.
      yield* TestClock.adjust(ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS - 2 * MINUTE);
      expect(readsOf("c@example.com")).toBe(1);
      yield* TestClock.adjust(MINUTE);
      // a read fine once (at 3 min) and fails now: its reading stays, the failure is reported.
      expect(readsOf("a@example.com")).toBe(2);
      const failing = accounts.get("a")!;
      expect(failing.usageLimits).toEqual(reading(33));
      expect(failing.probe.failures).toBe(1);
      expect(failing.probe.failure?.reason).toBe("failed");
      yield* TestClock.adjust(MINUTE);
      expect(readsOf("c@example.com")).toBe(2);
      // c's second failure doubles the wait: nothing for two intervals.
      yield* TestClock.adjust(2 * ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS - 2 * MINUTE);
      expect(readsOf("c@example.com")).toBe(2);
      yield* TestClock.adjust(2 * MINUTE);
      expect(readsOf("c@example.com")).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.effect("gives up on a read that hangs and records a timeout", () =>
    Effect.gen(function* () {
      const { pool, a } = yield* harness();
      const started = yield* Deferred.make<void>();
      const prober = yield* makeAntigravityAccountProber({
        instanceId,
        pool,
        read: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        onProbed: Effect.void,
      });
      const fiber = yield* Effect.forkChild(prober.probe(a.id));
      yield* Deferred.await(started);
      yield* TestClock.adjust(59_000);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1_000);
      expect(yield* Fiber.join(fiber)).toBe("failed");
      expect((yield* pool.list).find((entry) => entry.id === a.id)?.probe.failure?.reason).toBe(
        "timeout",
      );
      // The token was given back: it can be lent again.
      expect(yield* pool.beginProbe(a.id)).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("manual refresh", () => {
  it.effect("reads one named account at once, whenever it was last read", () =>
    Effect.gen(function* () {
      const { prober, reads, probed, a } = yield* harness();
      yield* prober.refresh(a.id);
      yield* prober.refresh(a.id);
      expect(reads).toEqual(["a@example.com", "a@example.com"]);
      expect(probed()).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reads every account that is not in use, one by one, and never the one in use", () =>
    Effect.gen(function* () {
      const { prober, reads, probed } = yield* harness();
      yield* prober.refresh();
      expect(reads).toEqual(["a@example.com", "c@example.com"]);
      expect(probed()).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("does nothing for the account in use and rejects one it does not know", () =>
    Effect.gen(function* () {
      const { prober, reads, b } = yield* harness();
      yield* prober.refresh(b.id);
      expect(reads).toEqual([]);
      const error = yield* prober.refresh("0123456789abcdef").pipe(Effect.flip);
      expect(error._tag).toBe("ProviderSetupError");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("discards a read when the account becomes the one in use meanwhile", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const { pool, a } = yield* harness();
      let published = 0;
      const watched = yield* makeAntigravityAccountProber({
        instanceId,
        pool,
        read: (text) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as({ _tag: "Read", token: text, limits: reading(5) } as const),
          ),
        onProbed: Effect.sync(() => {
          published++;
        }),
      });
      const fiber = yield* Effect.forkChild(watched.probe(a.id));
      yield* Deferred.await(started);
      yield* pool.select(a.id);
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(fiber)).toBe("discarded");
      expect(published).toBe(0);
      expect((yield* pool.list).find((entry) => entry.id === a.id)?.usageLimits).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

// A stand-in for `agy acp`: answers initialize and authenticate, and rewrites the token file the way
// agy does when it renews a sign-in. It logs what it was asked and the environment it was given.
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.GEMINI_HOME;
const log = (entry) => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + "\\n");
log({
  argv: process.argv.slice(2),
  home,
  fileStorage: process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE,
  autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  ssh: Boolean(process.env.SSH_CONNECTION),
  browser: Boolean(process.env.BROWSER),
});
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.id === undefined) continue;
    const method = message.method === "auth/login" ? "authenticate" : message.method;
    log({ method });
    const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }) + "\\n");
    if (method === "initialize") {
      reply({ result: { protocolVersion: 2, agentInfo: { name: "fake-agy", version: "1.5.16" }, agentCapabilities: {}, authMethods: [{ id: "oauth-personal", name: "Google" }] } });
    } else if (method === "authenticate") {
      if (process.env.FAKE_AGY_MODE === "signed-out") {
        reply({ error: { code: -32603, message: "No browser is available here" } });
        continue;
      }
      const file = path.join(home, "antigravity-acp", "antigravity-oauth-token");
      const token = JSON.parse(fs.readFileSync(file, "utf8"));
      token.token.access_token = "renewed-access";
      token.token.expiry = "2099-01-01T00:00:00Z";
      fs.writeFileSync(file, JSON.stringify(token));
      reply({ result: {} });
    } else {
      reply({ error: { code: -32601, message: "unexpected " + message.method } });
    }
  }
});
`;

describe("reading a saved account with agy", () => {
  const quota = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.7 }],
      },
    ],
  };

  const reader = Effect.fn("AntigravityBackgroundProbeTest.reader")(function* (
    mode?: "signed-out",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const agy = path.join(root, "agy");
    const log = path.join(root, "agy.log");
    yield* fs.writeFileString(agy, FAKE_AGY, { mode: 0o755 });
    yield* fs.chmod(agy, 0o755);
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        return HttpClientResponse.fromWeb(
          request,
          Response.json(request.url.includes("userinfo") ? { id: "google-1" } : quota),
        );
      }),
    );
    const make = makeAntigravityAccountReader({
      resolveExecutablePath: Effect.succeed(agy),
      baseEnv: {
        ...(yield* HostProcess.Environment),
        FAKE_AGY_LOG: log,
        ...(mode === undefined ? {} : { FAKE_AGY_MODE: mode }),
      },
      auth: { authMethod: "oauth-personal", apiKey: "", gcpProject: "", gcpLocation: "" },
      userHome: path.join(root, "home"),
      tempRoot: path.join(root, "tmp"),
      proxyDispatcher: undefined,
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    return {
      root,
      requests,
      read: yield* make,
      agyLog: fs.readFileString(log).pipe(
        Effect.map((text) =>
          text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ),
      ),
      leftovers: fs.readDirectory(path.join(root, "tmp")),
    };
  });

  const secretToken = JSON.stringify({
    token: {
      access_token: "stale-access",
      refresh_token: "refresh-a",
      expiry: "2000-01-01T00:00:00Z",
    },
    id_token_email: "a@example.com",
  });

  // A real child process: the one place this file needs the wall clock.
  it.live(
    "renews the copy with initialize and authenticate only, reads the quota with it, and cleans up",
    () =>
      Effect.gen(function* () {
        const { read, requests, agyLog, leftovers } = yield* reader();
        const outcome = yield* read(secretToken);
        expect(outcome._tag).toBe("Read");
        if (outcome._tag !== "Read") return;
        expect(JSON.parse(outcome.token).token.access_token).toBe("renewed-access");
        expect(outcome.limits.windows.map((window) => window.id)).toEqual(["gemini-5h"]);
        // The quota was read with the renewed token, not the stale one.
        expect(requests.some((request) => request.authorization === "Bearer renewed-access")).toBe(
          true,
        );
        expect(requests.some((request) => request.authorization === "Bearer stale-access")).toBe(
          false,
        );
        const entries = yield* agyLog;
        expect(entries.filter((entry) => entry.method).map((entry) => entry.method)).toEqual([
          "initialize",
          "authenticate",
        ]);
        const started = entries[0];
        // agy runs the way Extend runs a profile of its own: file storage, no update, no browser.
        expect(started).toMatchObject({
          fileStorage: "1",
          autoUpdate: "1",
          ssh: true,
          browser: true,
        });
        expect(started.argv.slice(0, 1)).toEqual(["acp"]);
        expect(started.argv).toContain("--gemini-dir");
        expect(started.argv[started.argv.indexOf("--gemini-dir") + 1]).toBe(started.home);
        // The private home, with its copy of the token, is gone.
        expect(yield* leftovers).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("reports an expired sign-in when agy has to ask for a browser", () =>
    Effect.gen(function* () {
      const { read, leftovers } = yield* reader("signed-out");
      expect(yield* read(secretToken)).toEqual({ _tag: "Failed", reason: "expired" });
      expect(yield* leftovers).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("reports an unavailable agy without starting anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const make = makeAntigravityAccountReader({
        resolveExecutablePath: Effect.fail({ detail: "agy is not installed" }),
        baseEnv: {},
        auth: { authMethod: "oauth-personal", apiKey: "", gcpProject: "", gcpLocation: "" },
        userHome: root,
        tempRoot: path.join(root, "tmp"),
        proxyDispatcher: undefined,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
      );
      expect(yield* (yield* make)(secretToken)).toEqual({ _tag: "Failed", reason: "unavailable" });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
