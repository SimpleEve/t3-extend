import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
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
const memoryPool = (
  options: {
    readonly list?: (
      all: Effect.Effect<ReadonlyArray<AntigravityAccount>>,
    ) => Effect.Effect<ReadonlyArray<AntigravityAccount>>;
  } = {},
) => {
  const accounts = new Map<string, AntigravityAccount>(
    ["a", "b", "c"].map((id) => [id, account(id, { current: id === "b", usageLimits: null })]),
  );
  const lent = new Set<string>();
  const everyone = Effect.sync((): ReadonlyArray<AntigravityAccount> => [...accounts.values()]);
  const pool = {
    list: Effect.suspend(() => (options.list === undefined ? everyone : options.list(everyone))),
    cancelProbe: (lease: { readonly id: string }) =>
      Effect.sync(() => {
        lent.delete(lease.id);
      }),
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
    readonly list?: (
      all: Effect.Effect<ReadonlyArray<AntigravityAccount>>,
    ) => Effect.Effect<ReadonlyArray<AntigravityAccount>>;
  } = {},
) {
  const { pool, accounts } = memoryPool(options.list === undefined ? {} : { list: options.list });
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
    lifetime: yield* Effect.scope,
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
    lifetime: yield* Effect.scope,
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
        lifetime: yield* Effect.scope,
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
        lifetime: yield* Effect.scope,
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

describe("an interrupted read", () => {
  /** A prober over the harness's real pool whose reader says it has started, then never answers. */
  const stuck = Effect.fn("AntigravityBackgroundProbeTest.stuck")(function* (
    lifetime: Scope.Scope,
  ) {
    const base = yield* harness();
    const started = yield* Deferred.make<void>();
    const reads: Array<string> = [];
    const prober = yield* makeAntigravityAccountProber({
      instanceId,
      pool: base.pool,
      read: (text) => {
        reads.push(emailOf(text));
        return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      },
      onProbed: Effect.void,
      lifetime,
    });
    const untouched = (id: string) =>
      base.pool.list.pipe(
        Effect.map((accounts) => accounts.find((account) => account.id === id)!),
        Effect.map((account) => ({
          probe: account.probe,
          due: nextAntigravityProbeAt(account),
          usageLimits: account.usageLimits,
        })),
      );
    return { ...base, prober, started, reads, untouched };
  });
  const NEVER = { lastAttemptAt: null, failures: 0, failure: null };

  it.effect("is not a failure: the token comes back and the schedule stays as it was", () =>
    Effect.gen(function* () {
      const { pool, prober, started, a, untouched } = yield* stuck(yield* Effect.scope);
      const fiber = yield* Effect.forkChild(prober.probe(a.id));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(yield* untouched(a.id)).toEqual({ probe: NEVER, due: 0, usageLimits: null });
      expect(yield* pool.beginProbe(a.id)).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("gives the token back when it is cut short while the verdict is being saved", () =>
    Effect.gen(function* () {
      const { pool, a } = yield* harness();
      const finishing = yield* Deferred.make<void>();
      const prober = yield* makeAntigravityAccountProber({
        instanceId,
        // The gap the review found: the read is over, the lease still held, the pool busy.
        pool: {
          ...pool,
          finishProbe: () =>
            Deferred.succeed(finishing, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.as("saved" as const),
            ),
        },
        read: (text) => Effect.succeed({ _tag: "Read", token: text, limits: reading(5) }),
        onProbed: Effect.void,
        lifetime: yield* Effect.scope,
      });
      const fiber = yield* Effect.forkChild(prober.probe(a.id));
      yield* Deferred.await(finishing);
      yield* Fiber.interrupt(fiber);
      const listed = (yield* pool.list).find((account) => account.id === a.id)!;
      expect(listed.probe).toEqual(NEVER);
      expect(listed.usageLimits).toBeNull();
      expect(yield* pool.beginProbe(a.id)).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops a refresh of every account when the instance goes away, and no one failed", () =>
    Effect.gen(function* () {
      const lifetime = yield* Scope.make();
      const { pool, prober, started, reads, a, c, untouched } = yield* stuck(lifetime);
      const refreshing = yield* Effect.forkChild(prober.refresh());
      yield* Deferred.await(started);
      yield* Scope.close(lifetime, Exit.void);
      // The request ends quietly, the second account is never read, and nothing is recorded.
      yield* Fiber.join(refreshing);
      expect(reads).toEqual(["a@example.com"]);
      expect(yield* untouched(a.id)).toEqual({ probe: NEVER, due: 0, usageLimits: null });
      expect((yield* untouched(c.id)).probe).toEqual(NEVER);
      expect(yield* pool.beginProbe(a.id)).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops a refresh when the request that asked for it goes away", () =>
    Effect.gen(function* () {
      const { pool, prober, started, reads, a, untouched } = yield* stuck(yield* Effect.scope);
      const refreshing = yield* Effect.forkChild(prober.refresh());
      yield* Deferred.await(started);
      yield* Fiber.interrupt(refreshing);
      expect(reads).toEqual(["a@example.com"]);
      expect(yield* untouched(a.id)).toEqual({ probe: NEVER, due: 0, usageLimits: null });
      expect(yield* pool.beginProbe(a.id)).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("the scheduler", () => {
  it.effect("logs a tick that goes wrong and carries on with the next one", () => {
    const logged: Array<string> = [];
    return Effect.gen(function* () {
      let lists = 0;
      const { prober, reads } = yield* scheduleHarness({
        list: (all) => (++lists === 1 ? Effect.die("the pool broke") : all),
      });
      yield* startAntigravityBackgroundProbe({
        enabled: true,
        settings: { backgroundAccountCheck: true },
        prober,
      });
      yield* TestClock.adjust(ANTIGRAVITY_BACKGROUND_PROBE_START_DELAY_MS);
      expect(reads).toEqual([]);
      expect(logged).toHaveLength(1);
      yield* TestClock.adjust(ANTIGRAVITY_BACKGROUND_PROBE_TICK_MS);
      expect(reads).toEqual(["a@example.com"]);
      expect(logged).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logged.push(String(options.message));
          }),
        ]),
      ),
    );
  });
});

// A stand-in for `agy acp`: answers initialize and authenticate, and rewrites the token file the way
// agy does when it renews a sign-in. It logs what it was asked and the environment it was given.
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.GEMINI_HOME;
const log = (entry) => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + "\\n");
const tokenFile = path.join(home, "antigravity-acp", "antigravity-oauth-token");
const bytes = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? bytes(full) : fs.lstatSync(full).size;
  }
  return total;
};
log({
  argv: process.argv.slice(2),
  home,
  pid: process.pid,
  fileStorage: process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE,
  acpFileStorage: process.env.AGY_ACP_FORCE_FILE_STORAGE,
  autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  ssh: Boolean(process.env.SSH_CONNECTION),
  browser: Boolean(process.env.BROWSER),
  proxy: process.env.HTTPS_PROXY,
  noProxy: process.env.NO_PROXY,
  tokenMode: (fs.statSync(tokenFile).mode & 0o777).toString(8),
});
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.id === undefined) continue;
    const method = message.method;
    log({ method });
    const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }) + "\\n");
    // Like agy 1.5.15 seen from the probe: a v2-shaped greeting, then only the v1 \`authenticate\`.
    if (method === "initialize") {
      reply({ result: { protocolVersion: 2, info: { name: "fake-agy", version: "1.5.15" }, capabilities: {}, authMethods: [{ id: "oauth-personal", name: "Google" }] } });
    } else if (method === "auth/login") {
      reply({ error: { code: -32601, message: "Method not found: auth/login" } });
    } else if (method === "authenticate") {
      log({ homeBytes: bytes(home), tmpBytes: bytes(process.env.TMPDIR) });
      if (process.env.FAKE_AGY_MODE === "hang") continue;
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
    options: { readonly mode?: "signed-out" | "hang"; readonly networkProxy?: string } = {},
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
    // Tells the test when agy itself (not the browser helper) has been started, and keeps its handle.
    const base = yield* ChildProcessSpawner.ChildProcessSpawner;
    const agyStarted = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
    const spawner = ChildProcessSpawner.make((command) =>
      base
        .spawn(command)
        .pipe(
          Effect.tap((handle) =>
            command._tag === "StandardCommand" && command.command === agy
              ? Deferred.succeed(agyStarted, handle)
              : Effect.void,
          ),
        ),
    );
    const make = makeAntigravityAccountReader({
      acquireExecutable: Effect.succeed({ executablePath: agy }),
      baseEnv: {
        ...(yield* HostProcess.Environment),
        FAKE_AGY_LOG: log,
        ...(options.mode === undefined ? {} : { FAKE_AGY_MODE: options.mode }),
      },
      auth: {
        authMethod: "oauth-personal",
        apiKey: "",
        gcpProject: "",
        gcpLocation: "",
        ...(options.networkProxy === undefined ? {} : { networkProxy: options.networkProxy }),
      },
      userHome: path.join(root, "home"),
      tempRoot: path.join(root, "tmp"),
      proxyDispatcher: undefined,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return {
      root,
      requests,
      agyStarted,
      read: yield* make,
      agyRan: fs.exists(log),
      agyLog: fs.readFileString(log).pipe(
        Effect.map((text) =>
          text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ),
      ),
      leftovers: fs
        .readDirectory(path.join(root, "tmp"))
        .pipe(Effect.orElseSucceed((): Array<string> => [])),
    };
  });

  const tokenExpiringIn = (millis: number, accessToken = "access-a") =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        JSON.stringify({
          token: {
            access_token: accessToken,
            refresh_token: "refresh-a",
            expiry: DateTime.formatIso(DateTime.makeUnsafe(now + millis)),
          },
          id_token_email: "a@example.com",
        }),
      ),
    );

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
        const { read, requests, agyLog, leftovers } = yield* reader({
          networkProxy: "http://127.0.0.1:7890",
        });
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
          acpFileStorage: "1",
          autoUpdate: "1",
          ssh: true,
          browser: true,
          // The instance's proxy reaches agy, and the saved token it is handed is private.
          proxy: "http://127.0.0.1:7890/",
          tokenMode: "600",
        });
        expect(started.noProxy).toContain("127.0.0.1");
        // What one launch writes by itself: the private home and the run directory stay tiny. The real
        // runtime's own unpacking happens inside its run directory and still needs measuring with it.
        const sizes = entries.find((entry) => entry.homeBytes !== undefined);
        expect(sizes.homeBytes + sizes.tmpBytes).toBeLessThan(64 * 1024);
        expect(started.argv.slice(0, 1)).toEqual(["acp"]);
        expect(started.argv).toContain("--gemini-dir");
        expect(started.argv[started.argv.indexOf("--gemini-dir") + 1]).toBe(started.home);
        // The private home, with its copy of the token, is gone.
        expect(yield* leftovers).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("reports an expired sign-in when agy has to ask for a browser", () =>
    Effect.gen(function* () {
      const { read, leftovers } = yield* reader({ mode: "signed-out" });
      expect(yield* read(secretToken)).toEqual({ _tag: "Failed", reason: "expired" });
      expect(yield* leftovers).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  const liveLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

  // fork: agy is a heavy launch, so a token that is still good is read with as it is.
  it.live("does not start agy for a token that stays valid, and reads the quota with it", () =>
    Effect.gen(function* () {
      const { read, requests, agyRan, leftovers } = yield* reader();
      const valid = yield* tokenExpiringIn(30 * 60_000, "good-access");
      const outcome = yield* read(valid);
      expect(outcome._tag).toBe("Read");
      if (outcome._tag !== "Read") return;
      // The token goes back unchanged, so nothing is rewritten in the slot.
      expect(outcome.token).toBe(valid);
      expect(requests.some((request) => request.authorization === "Bearer good-access")).toBe(true);
      expect(yield* agyRan).toBe(false);
      expect(yield* leftovers).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  it.live("starts agy for a token that is about to expire, and for one without an expiry", () =>
    Effect.gen(function* () {
      const nearly = yield* reader();
      expect((yield* nearly.read(yield* tokenExpiringIn(4 * 60_000)))._tag).toBe("Read");
      expect(yield* nearly.agyRan).toBe(true);
      const unknown = yield* reader();
      yield* unknown.read(
        JSON.stringify({
          token: { access_token: "x", refresh_token: "r" },
          id_token_email: "a@example.com",
        }),
      );
      expect(yield* unknown.agyRan).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  it.live("stops agy and removes the private home when the read is interrupted", () =>
    Effect.gen(function* () {
      const { read, agyStarted, leftovers } = yield* reader({ mode: "hang" });
      const fiber = yield* Effect.forkChild(read(secretToken));
      const handle = yield* Deferred.await(agyStarted);
      expect(yield* handle.isRunning).toBe(true);
      yield* Fiber.interrupt(fiber);
      expect(yield* handle.isRunning).toBe(false);
      expect(yield* leftovers).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  // A real prober over a real pool and the real reader, with agy that never answers.
  it.live("times out a read that hangs: agy is stopped, the home is gone, the lease is free", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { read, agyStarted, leftovers } = yield* reader({ mode: "hang" });
      const profile = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${profile}/antigravity-acp`, { recursive: true });
      const pool = yield* makeAntigravityAccountPool(profile);
      for (const email of ["a@example.com", "b@example.com"]) {
        yield* pool.beginAdd;
        yield* fs.writeFileString(
          `${profile}/antigravity-acp/antigravity-oauth-token`,
          secretToken.replace("a@example.com", email),
        );
        yield* pool.settleAdd;
      }
      const [first] = yield* pool.list;
      const prober = yield* makeAntigravityAccountProber({
        instanceId,
        pool,
        read,
        onProbed: Effect.void,
        lifetime: yield* Effect.scope,
        timeout: Duration.seconds(2),
      });
      expect(yield* prober.probe(first!.id)).toBe("failed");
      const handle = yield* Deferred.await(agyStarted);
      expect(yield* handle.isRunning).toBe(false);
      expect(yield* leftovers).toEqual([]);
      const listed = (yield* pool.list).find((account) => account.id === first!.id)!;
      expect(listed.probe.failure?.reason).toBe("timeout");
      expect(yield* pool.beginProbe(first!.id)).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  it.live("reports an unavailable agy without starting anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const make = makeAntigravityAccountReader({
        acquireExecutable: Effect.fail({ detail: "agy is not installed" }),
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
