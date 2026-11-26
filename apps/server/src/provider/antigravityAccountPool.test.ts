import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { makeAntigravityAccountPool, type AntigravityAccount } from "./antigravityAccountPool.ts";

const HOUR = 3_600_000;

const token = (email: string, accessToken = `access-${email}`) =>
  JSON.stringify({
    token: {
      access_token: accessToken,
      refresh_token: `refresh-${email}`,
      expiry: "2099-01-01T00:00:00Z",
    },
    auth_method: "consumer",
    id_token_email: email,
  });

const fixture = Effect.fn("AntigravityAccountPoolTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profile = yield* fs.makeTempDirectoryScoped();
  const acp = path.join(profile, "antigravity-acp");
  yield* fs.makeDirectory(acp, { recursive: true });
  const currentPath = path.join(acp, "antigravity-oauth-token");
  const pool = yield* makeAntigravityAccountPool(profile);
  return {
    fs,
    path,
    pool,
    acp,
    currentPath,
    /** What agy leaves behind after `--login`, or after refreshing its token. */
    agyWrites: (text: string) => fs.writeFileString(currentPath, text),
    readCurrent: () => fs.readFileString(currentPath),
    currentExists: () => fs.exists(currentPath),
    slotText: (id: string) =>
      fs.readFileString(path.join(acp, "accounts", id, "antigravity-oauth-token")),
    /** The `--login` run of the real flow: stash the current account, sign in as `email`. */
    addAccount: (email: string, accessToken?: string) =>
      Effect.gen(function* () {
        yield* pool.beginAdd;
        yield* fs.writeFileString(currentPath, token(email, accessToken));
        yield* pool.settleAdd;
      }),
  };
});

const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const emails = (accounts: ReadonlyArray<{ email: string | null }>) =>
  accounts.map((account) => account.email);

describe("Antigravity account pool", () => {
  it.effect(
    "shows the instance's existing sign-in as its first account without changing anything",
    () =>
      Effect.gen(function* () {
        const { pool, agyWrites, currentPath, fs, path, acp } = yield* fixture();
        expect(yield* pool.list).toEqual([]);
        yield* agyWrites(token("a@example.com"));
        const accounts = yield* pool.list;
        expect(accounts).toHaveLength(1);
        expect(accounts[0]).toMatchObject({
          email: "a@example.com",
          current: true,
          exhaustedUntil: null,
        });
        // Listing never writes: no state or slots appear until the pool is used.
        expect(yield* fs.exists(path.join(acp, "accounts"))).toBe(false);
        expect(yield* fs.readFileString(currentPath)).toBe(token("a@example.com"));
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("adds accounts through a login and keeps the earlier one saved", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount, readCurrent, slotText } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      const accounts = yield* pool.list;
      expect(emails(accounts)).toEqual(["a@example.com", "b@example.com"]);
      expect(accounts.map((account) => account.current)).toEqual([false, true]);
      expect(yield* readCurrent()).toBe(token("b@example.com"));
      expect(yield* slotText(accounts[0]!.id)).toBe(token("a@example.com"));
      expect(yield* slotText(accounts[1]!.id)).toBe(token("b@example.com"));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "updates the slot when the same email signs in again instead of adding a second account",
    () =>
      Effect.gen(function* () {
        const { pool, addAccount, slotText } = yield* fixture();
        yield* addAccount("a@example.com", "old");
        yield* addAccount("b@example.com");
        yield* addAccount("A@Example.com", "new");
        const accounts = yield* pool.list;
        expect(emails(accounts)).toEqual(["a@example.com", "b@example.com"]);
        expect(accounts.find((account) => account.current)?.email).toBe("a@example.com");
        expect(yield* slotText(accounts[0]!.id)).toContain("new");
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("puts the previous account back when a login does not finish", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, readCurrent } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* pool.beginAdd;
      // Cancelled or failed: agy wrote nothing.
      yield* pool.settleAdd;
      expect(yield* readCurrent()).toBe(token("a@example.com"));
      expect(emails(yield* pool.list)).toEqual(["a@example.com"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("saves the token agy refreshed back into its slot before switching away", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount, slotText, readCurrent } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      const [a, b] = yield* pool.list;
      yield* pool.select(a!.id);
      expect(yield* readCurrent()).toBe(token("a@example.com"));
      // agy refreshes the access token in the file it owns.
      yield* agyWrites(token("a@example.com", "refreshed"));
      yield* pool.select(b!.id);
      expect(yield* slotText(a!.id)).toContain("refreshed");
      expect(yield* readCurrent()).toBe(token("b@example.com"));
      expect((yield* pool.list).find((account) => account.current)?.email).toBe("b@example.com");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects ids that are not saved accounts, including paths", () =>
    Effect.gen(function* () {
      const { pool, agyWrites } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      for (const id of ["../escape", "0123456789abcdef", ""]) {
        expect((yield* pool.select(id).pipe(Effect.flip)).detail).toContain("Unknown");
        expect((yield* pool.remove(id).pipe(Effect.flip)).detail).toContain("Unknown");
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "moves to another account when the current one is removed, and signs out after the last",
    () =>
      Effect.gen(function* () {
        const { pool, agyWrites, addAccount, readCurrent, currentExists, fs, acp, path } =
          yield* fixture();
        yield* agyWrites(token("a@example.com"));
        yield* addAccount("b@example.com");
        yield* addAccount("c@example.com");
        const [a, b, c] = yield* pool.list;
        // A saved account that is not in use goes without touching the current one.
        yield* pool.remove(a!.id);
        expect(yield* readCurrent()).toBe(token("c@example.com"));
        expect(yield* fs.exists(path.join(acp, "accounts", a!.id))).toBe(false);
        // The account in use goes: the next one takes its place.
        yield* pool.remove(c!.id);
        expect(yield* readCurrent()).toBe(token("b@example.com"));
        expect(emails(yield* pool.list)).toEqual(["b@example.com"]);
        yield* pool.remove(b!.id);
        expect(yield* currentExists()).toBe(false);
        expect(yield* pool.list).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("leaves nothing behind when signing out", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount, currentExists, fs, path, acp } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      yield* pool.clear;
      expect(yield* currentExists()).toBe(false);
      expect(yield* fs.exists(path.join(acp, "accounts"))).toBe(false);
      expect(yield* pool.list).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.runIf(HostProcess.Platform.defaultValue() !== "win32")(
    "keeps token files private to the owner",
    () =>
      Effect.gen(function* () {
        const { pool, agyWrites, addAccount, fs, path, acp } = yield* fixture();
        yield* agyWrites(token("a@example.com"));
        yield* addAccount("b@example.com");
        const [a] = yield* pool.list;
        for (const file of [
          path.join(acp, "accounts", "state.json"),
          path.join(acp, "accounts", a!.id, "antigravity-oauth-token"),
        ]) {
          expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
        }
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("treats a damaged state.json as no pool and rebuilds it on the next change", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount, fs, path, acp } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      yield* fs.writeFileString(path.join(acp, "accounts", "state.json"), "{not json");
      expect(emails(yield* pool.list)).toEqual(["b@example.com"]);
      yield* addAccount("c@example.com");
      expect(emails(yield* pool.list)).toEqual(["b@example.com", "c@example.com"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.runIf(symlinksSupported)(
    "replaces a linked token with a plain copy once it is used",
    () =>
      Effect.gen(function* () {
        const { pool, fs, path, acp, currentPath, readCurrent } = yield* fixture();
        const source = path.join(acp, "source-token");
        yield* fs.writeFileString(source, token("a@example.com"));
        yield* fs.symlink(source, currentPath);
        yield* pool.beginAdd;
        yield* fs.writeFileString(currentPath, token("b@example.com"));
        yield* pool.settleAdd;
        expect((yield* fs.readLink(currentPath).pipe(Effect.option))._tag).toBe("None");
        expect(yield* readCurrent()).toBe(token("b@example.com"));
        // The file the link pointed at is not edited.
        expect(yield* fs.readFileString(source)).toBe(token("a@example.com"));
        expect(emails(yield* pool.list)).toEqual(["a@example.com", "b@example.com"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("Antigravity account pool rotation", () => {
  it.effect("names the next account, and swaps it in only when agy is about to start", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const { pool, agyWrites, addAccount, readCurrent } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      yield* pool.select((yield* pool.list)[0]!.id);
      const resetAt = 1_000_000 + 2 * HOUR;
      const plan = yield* pool.markExhausted(resetAt);
      expect(plan).toEqual({
        _tag: "Rotate",
        from: { email: "a@example.com", resetAt },
        to: { email: "b@example.com" },
      });
      // The old agy may still be running, so the file is untouched until the next start.
      expect(yield* readCurrent()).toBe(token("a@example.com"));
      const accounts = yield* pool.list;
      expect(accounts[0]).toMatchObject({ current: true, exhaustedUntil: resetAt });
      const spent = accounts[0]!.id;
      expect(yield* pool.ensureAvailable({ rotate: true })).toEqual({ swapped: true, spent });
      expect(yield* readCurrent()).toBe(token("b@example.com"));
      expect((yield* pool.list).find((account) => account.current)?.email).toBe("b@example.com");
      // The account left behind can now be read, which tells which of its windows ran out.
      const lease = yield* pool.beginProbe(spent);
      expect(lease?.id).toBe(spent);
      if (lease) yield* pool.cancelProbe(lease);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps the refreshed token of the account it leaves", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount, slotText } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      const [a] = yield* pool.list;
      yield* pool.select(a!.id);
      yield* pool.markExhausted();
      yield* agyWrites(token("a@example.com", "refreshed-on-exit"));
      yield* pool.ensureAvailable({ rotate: true });
      expect(yield* slotText(a!.id)).toContain("refreshed-on-exit");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops when every account is spent, reporting the earliest reset", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const { pool, agyWrites, addAccount, readCurrent } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      const [a, b] = yield* pool.list;
      yield* pool.select(a!.id);
      yield* pool.markExhausted(1_000_000 + 3 * HOUR);
      yield* pool.ensureAvailable({ rotate: true });
      expect(yield* readCurrent()).toBe(token("b@example.com"));
      const plan = yield* pool.markExhausted(1_000_000 + HOUR);
      expect(plan).toEqual({ _tag: "AllExhausted", earliestResetAt: 1_000_000 + HOUR });
      // Nothing to move to: the current account stays, and starting agy does not swap.
      yield* pool.ensureAvailable({ rotate: true });
      expect(yield* readCurrent()).toBe(token("b@example.com"));
      expect([a!.id, b!.id]).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "uses an account again once its reset time has passed, without any clock of its own",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000_000);
        const { pool, agyWrites, addAccount, readCurrent } = yield* fixture();
        yield* agyWrites(token("a@example.com"));
        yield* addAccount("b@example.com");
        yield* pool.select((yield* pool.list)[0]!.id);
        yield* pool.markExhausted(1_000_000 + HOUR);
        yield* pool.ensureAvailable({ rotate: true });
        yield* pool.markExhausted(1_000_000 + 2 * HOUR);
        expect(yield* readCurrent()).toBe(token("b@example.com"));
        yield* TestClock.adjust(HOUR + 1);
        // a's mark has expired, b's has not: the next start moves back to a.
        yield* pool.ensureAvailable({ rotate: true });
        expect(yield* readCurrent()).toBe(token("a@example.com"));
        expect((yield* pool.list).map((account) => account.exhaustedUntil)).toEqual([
          null,
          1_000_000 + 2 * HOUR,
        ]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("assumes a five-hour window when the failure names no reset time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const { pool, agyWrites, addAccount } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      yield* pool.markExhausted();
      yield* pool.markExhausted(1_000_000 - 1);
      expect((yield* pool.list).map((account) => account.exhaustedUntil)).toEqual([
        null,
        1_000_000 + 5 * HOUR,
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("only restores the current account when rotation is off", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount, readCurrent, currentExists } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      yield* pool.markExhausted();
      expect(yield* pool.ensureAvailable({ rotate: false })).toEqual({ swapped: false });
      expect(yield* readCurrent()).toBe(token("b@example.com"));
      // A sign-in cut short by a crash left no current file; the last account comes back.
      yield* pool.beginAdd;
      expect(yield* currentExists()).toBe(false);
      yield* pool.ensureAvailable({ rotate: false });
      expect(yield* readCurrent()).toBe(token("b@example.com"));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "a thread that failed before another switched accounts does not spend the new one",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000_000);
        const { pool, agyWrites, addAccount, readCurrent } = yield* fixture();
        yield* agyWrites(token("a@example.com"));
        yield* addAccount("b@example.com");
        yield* pool.select((yield* pool.list)[0]!.id);
        yield* TestClock.adjust(1);
        // Two threads on a send a prompt; both come back over a's limit.
        const sentAt = 1_000_001;
        yield* TestClock.adjust(1);
        const first = yield* pool.markExhausted(1_000_000 + HOUR, sentAt);
        expect(first._tag).toBe("Rotate");
        yield* pool.ensureAvailable({ rotate: true });
        expect(yield* readCurrent()).toBe(token("b@example.com"));
        yield* TestClock.adjust(1);
        const second = yield* pool.markExhausted(1_000_000 + HOUR, sentAt);
        expect(second).toEqual({ _tag: "Moved", to: { email: "b@example.com" } });
        expect((yield* pool.list).map((account) => account.exhaustedUntil)).toEqual([
          1_000_000 + HOUR,
          null,
        ]);
        // A prompt sent on b after the switch does spend b.
        expect((yield* pool.markExhausted(1_000_000 + HOUR, 1_000_004))._tag).toBe("AllExhausted");
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("ignores state entries that are not account ids", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, fs, path, acp } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* pool.markExhausted();
      const outside = path.join(acp, "..", "outside");
      yield* fs.makeDirectory(outside, { recursive: true });
      yield* fs.writeFileString(
        path.join(outside, "antigravity-oauth-token"),
        token("outside@example.com"),
      );
      const statePath = path.join(acp, "accounts", "state.json");
      const state = JSON.parse(yield* fs.readFileString(statePath));
      yield* fs.writeFileString(
        statePath,
        JSON.stringify({ ...state, order: [...state.order, "../../outside"] }),
      );
      expect(emails(yield* pool.list)).toEqual(["a@example.com"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("has no account to rotate for an instance that is signed out", () =>
    Effect.gen(function* () {
      const { pool } = yield* fixture();
      expect(yield* pool.markExhausted(1)).toEqual({ _tag: "NoAccount" });
      yield* pool.ensureAvailable({ rotate: true });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("Antigravity account pool usage snapshots", () => {
  const reading = (usedPercent: number): ServerProviderUsageLimits => ({
    checkedAt: "2026-01-01T00:00:00.000Z",
    windows: [
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini · 5-hour",
        usedPercent,
        resetsAt: "2026-01-01T05:00:00.000Z",
        windowDurationMins: 300,
      },
    ],
  });

  it.effect(
    "remembers the reading of the account in use and keeps it once another takes over",
    () =>
      Effect.gen(function* () {
        const { pool, agyWrites, addAccount } = yield* fixture();
        yield* agyWrites(token("a@example.com"));
        expect(yield* pool.observeUsage(Effect.succeed(reading(30)))).toEqual(reading(30));
        yield* addAccount("b@example.com");
        yield* pool.observeUsage(Effect.succeed(reading(70)));
        const accounts = yield* pool.list;
        expect(accounts.map((account) => account.usageLimits?.windows[0]?.usedPercent)).toEqual([
          30, 70,
        ]);
        // A new reading replaces only the current account's snapshot.
        yield* pool.observeUsage(Effect.succeed(reading(80)));
        expect(
          (yield* pool.list).map((account) => account.usageLimits?.windows[0]?.usedPercent),
        ).toEqual([30, 80]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("lists no reading for an account that was never read", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      expect((yield* pool.list).map((account) => account.usageLimits)).toEqual([null, null]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("does not remember an unavailable reading or one that straddles a switch", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* addAccount("b@example.com");
      const [a, b] = yield* pool.list;
      yield* pool.observeUsage(
        Effect.succeed({
          checkedAt: "2026-01-01T00:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" as const },
        }),
      );
      // The account in use changes while the read is in flight.
      yield* pool.observeUsage(pool.select(a!.id).pipe(Effect.as(reading(55))));
      const after = yield* pool.list;
      expect(after.find((account) => account.id === b!.id)?.usageLimits).toBeNull();
      expect(after.find((account) => account.id === a!.id)?.usageLimits).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("drops an account's reading with the account, and all of them on sign-out", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount, fs, path, acp } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* pool.observeUsage(Effect.succeed(reading(10)));
      yield* addAccount("b@example.com");
      yield* pool.observeUsage(Effect.succeed(reading(20)));
      const [a] = yield* pool.list;
      yield* pool.remove(a!.id);
      expect(yield* fs.exists(path.join(acp, "accounts", a!.id))).toBe(false);
      expect(
        (yield* pool.list).map((account) => account.usageLimits?.windows[0]?.usedPercent),
      ).toEqual([20]);
      yield* pool.clear;
      expect(yield* fs.exists(path.join(acp, "accounts"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("ignores a damaged snapshot file", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, fs, path, acp } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* pool.observeUsage(Effect.succeed(reading(10)));
      const [a] = yield* pool.list;
      yield* fs.writeFileString(path.join(acp, "accounts", a!.id, "usage.json"), "{not json");
      // A pool that starts later reads the file from disk.
      const later = yield* makeAntigravityAccountPool(path.dirname(acp));
      expect((yield* later.list)[0]?.usageLimits).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps readings in memory once seen, so listing does not read every file again", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, fs, path, acp } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* pool.observeUsage(Effect.succeed(reading(10)));
      const [a] = yield* pool.list;
      const file = path.join(acp, "accounts", a!.id, "usage.json");
      const later = yield* makeAntigravityAccountPool(path.dirname(acp));
      expect((yield* later.list)[0]?.usageLimits?.windows[0]?.usedPercent).toBe(10);
      yield* fs.remove(file);
      expect((yield* later.list)[0]?.usageLimits?.windows[0]?.usedPercent).toBe(10);
      expect((yield* pool.list)[0]?.usageLimits?.windows[0]?.usedPercent).toBe(10);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("does not bring an old reading back when a removed account is added again", () =>
    Effect.gen(function* () {
      const { pool, agyWrites, addAccount } = yield* fixture();
      yield* agyWrites(token("a@example.com"));
      yield* pool.observeUsage(Effect.succeed(reading(10)));
      yield* addAccount("b@example.com");
      const [a] = yield* pool.list;
      yield* pool.remove(a!.id);
      yield* addAccount("a@example.com");
      expect(
        (yield* pool.list).find((account) => account.email === "a@example.com")?.usageLimits,
      ).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  // fork: reading the accounts that are not in use, in the background and on request.
  describe("background reads of saved accounts", () => {
    /** A pool of a (saved) and b (in use); a's slot is what a background read lends. */
    const twoAccounts = Effect.fn("AntigravityAccountPoolTest.twoAccounts")(function* () {
      const base = yield* fixture();
      yield* base.agyWrites(token("a@example.com"));
      yield* base.addAccount("b@example.com");
      const [a, b] = yield* base.pool.list;
      return { ...base, a: a!, b: b! };
    });
    const renewed = (email: string) => token(email, "renewed");

    it.effect("lends only an account that is saved and not in use", () =>
      Effect.gen(function* () {
        const { pool, a, b } = yield* twoAccounts();
        expect(yield* pool.beginProbe(b.id)).toBeUndefined();
        expect(yield* pool.beginProbe("0123456789abcdef")).toBeUndefined();
        expect(yield* pool.beginProbe("../escape")).toBeUndefined();
        const lease = yield* pool.beginProbe(a.id);
        expect(lease).toEqual({ id: a.id, token: token("a@example.com") });
        // One read of an account at a time.
        expect(yield* pool.beginProbe(a.id)).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("lends nothing while a sign-in is being added or nothing is in use", () =>
      Effect.gen(function* () {
        const { pool, a, b, agyWrites } = yield* twoAccounts();
        yield* pool.beginAdd;
        expect(yield* pool.beginProbe(a.id)).toBeUndefined();
        expect(yield* pool.beginProbe(b.id)).toBeUndefined();
        // `agy --login` has written the new account, but the pool has not taken it in yet.
        yield* agyWrites(token("c@example.com"));
        expect(yield* pool.beginProbe(a.id)).toBeUndefined();
        yield* pool.settleAdd;
        expect(yield* pool.beginProbe(a.id)).toBeDefined();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("saves the renewed token into the slot it came from, and the reading beside it", () =>
      Effect.gen(function* () {
        const { pool, a, b, slotText, readCurrent, fs, path, acp } = yield* twoAccounts();
        const lease = (yield* pool.beginProbe(a.id))!;
        const result = yield* pool.finishProbe(lease, {
          _tag: "Read",
          token: renewed("a@example.com"),
          limits: reading(42),
        });
        expect(result).toBe("saved");
        expect(yield* slotText(a.id)).toBe(renewed("a@example.com"));
        // The account in use and its slot are untouched.
        expect(yield* readCurrent()).toBe(token("b@example.com"));
        expect(yield* slotText(b.id)).toBe(token("b@example.com"));
        const after = yield* pool.list;
        expect(after.find((account) => account.id === a.id)).toMatchObject({
          usageLimits: reading(42),
          probe: { failures: 0, failure: null },
        });
        // Written through a temp file that is gone, so no reader sees half a token.
        expect(
          yield* fs.exists(path.join(acp, "accounts", a.id, "antigravity-oauth-token.t3-tmp")),
        ).toBe(false);
        // It can be lent again.
        expect(yield* pool.beginProbe(a.id)).toBeDefined();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("refuses a renewed token that belongs to another account", () =>
      Effect.gen(function* () {
        const { pool, a, slotText } = yield* twoAccounts();
        const lease = (yield* pool.beginProbe(a.id))!;
        const result = yield* pool.finishProbe(lease, {
          _tag: "Read",
          token: renewed("b@example.com"),
          limits: reading(42),
        });
        expect(result).toBe("failed");
        expect(yield* slotText(a.id)).toBe(token("a@example.com"));
        const listed = (yield* pool.list).find((account) => account.id === a.id);
        expect(listed?.usageLimits).toBeNull();
        expect(listed?.probe.failure?.reason).toBe("failed");
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("discards the answer when the account became the one in use meanwhile", () =>
      Effect.gen(function* () {
        const { pool, a, slotText, readCurrent, fs, path, acp } = yield* twoAccounts();
        const lease = (yield* pool.beginProbe(a.id))!;
        yield* pool.select(a.id);
        const result = yield* pool.finishProbe(lease, {
          _tag: "Read",
          token: renewed("a@example.com"),
          limits: reading(42),
        });
        expect(result).toBe("discarded");
        expect(yield* readCurrent()).toBe(token("a@example.com"));
        expect(yield* slotText(a.id)).toBe(token("a@example.com"));
        expect(yield* fs.exists(path.join(acp, "accounts", a.id, "usage.json"))).toBe(false);
        expect((yield* pool.list).find((account) => account.id === a.id)?.usageLimits).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("discards the answer when its slot changed, or the account or the pool went", () =>
      Effect.gen(function* () {
        const { pool, a, b, agyWrites, slotText, fs, path, acp } = yield* twoAccounts();
        // The account was in use and left again with a token agy refreshed.
        const first = (yield* pool.beginProbe(a.id))!;
        yield* pool.select(a.id);
        yield* agyWrites(token("a@example.com", "agy-refreshed"));
        yield* pool.select(b.id);
        expect(
          yield* pool.finishProbe(first, {
            _tag: "Read",
            token: renewed("a@example.com"),
            limits: reading(1),
          }),
        ).toBe("discarded");
        expect(yield* slotText(a.id)).toContain("agy-refreshed");
        // The account was removed.
        const second = (yield* pool.beginProbe(a.id))!;
        yield* pool.remove(a.id);
        expect(
          yield* pool.finishProbe(second, {
            _tag: "Read",
            token: renewed("a@example.com"),
            limits: reading(1),
          }),
        ).toBe("discarded");
        expect(yield* fs.exists(path.join(acp, "accounts", a.id))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("discards the answer after sign-out and leaves nothing behind", () =>
      Effect.gen(function* () {
        const { pool, a, fs, path, acp } = yield* twoAccounts();
        const lease = (yield* pool.beginProbe(a.id))!;
        yield* pool.clear;
        expect(
          yield* pool.finishProbe(lease, {
            _tag: "Read",
            token: renewed("a@example.com"),
            limits: reading(1),
          }),
        ).toBe("discarded");
        expect(yield* fs.exists(path.join(acp, "accounts"))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("keeps the old token and reading on a failure, and counts it", () =>
      Effect.gen(function* () {
        const { pool, a, slotText } = yield* twoAccounts();
        const ok = (yield* pool.beginProbe(a.id))!;
        yield* pool.finishProbe(ok, {
          _tag: "Read",
          token: renewed("a@example.com"),
          limits: reading(30),
        });
        yield* TestClock.adjust(5 * 60_000);
        const bad = (yield* pool.beginProbe(a.id))!;
        expect(yield* pool.finishProbe(bad, { _tag: "Failed", reason: "expired" })).toBe("failed");
        expect(yield* slotText(a.id)).toBe(renewed("a@example.com"));
        const listed = (yield* pool.list).find((account) => account.id === a.id)!;
        expect(listed.usageLimits).toEqual(reading(30));
        expect(listed.probe).toEqual({
          lastAttemptAt: 5 * 60_000,
          failures: 1,
          failure: { at: 5 * 60_000, reason: "expired" },
        });
        // A read that works wipes the failure.
        const again = (yield* pool.beginProbe(a.id))!;
        yield* pool.finishProbe(again, {
          _tag: "Read",
          token: renewed("a@example.com"),
          limits: reading(31),
        });
        expect((yield* pool.list).find((account) => account.id === a.id)?.probe.failures).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("still saves a token that was renewed when the quota could not be read", () =>
      Effect.gen(function* () {
        const { pool, a, slotText } = yield* twoAccounts();
        const lease = (yield* pool.beginProbe(a.id))!;
        expect(
          yield* pool.finishProbe(lease, {
            _tag: "Renewed",
            token: renewed("a@example.com"),
            reason: "unavailable",
          }),
        ).toBe("failed");
        expect(yield* slotText(a.id)).toBe(renewed("a@example.com"));
        expect(
          (yield* pool.list).find((account) => account.id === a.id)?.probe.failure?.reason,
        ).toBe("unavailable");
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    /** a runs out while in use (its last reading `during`), then b is in use again. */
    const spentAccount = Effect.fn("AntigravityAccountPoolTest.spentAccount")(function* (
      during?: ServerProviderUsageLimits,
    ) {
      const base = yield* twoAccounts();
      yield* base.pool.select(base.a.id);
      if (during !== undefined) yield* base.pool.observeUsage(Effect.succeed(during));
      yield* base.pool.markExhausted(10 * HOUR);
      yield* base.pool.select(base.b.id);
      const spent = () =>
        base.pool.list.pipe(
          Effect.map(
            (accounts) => accounts.find((account) => account.id === base.a.id)?.exhaustedUntil,
          ),
        );
      const read = Effect.fn("AntigravityAccountPoolTest.read")(function* (
        limits: ServerProviderUsageLimits,
      ) {
        const lease = (yield* base.pool.beginProbe(base.a.id))!;
        yield* base.pool.finishProbe(lease, { _tag: "Read", token: lease.token, limits });
      });
      return { ...base, spent, read };
    });
    /** A reading with a Gemini window and a Claude & GPT window, `used` percent each. */
    const bothGroups = (gemini: number, claude: number): ServerProviderUsageLimits => ({
      checkedAt: "2026-01-01T00:00:00.000Z",
      windows: [
        { ...reading(gemini).windows[0]! },
        {
          id: "3p-5h",
          kind: "session",
          label: "Claude & GPT (shared) · 5-hour",
          usedPercent: claude,
          windowDurationMins: 300,
        },
      ],
    });

    it.effect("clears a spent mark when the new reading shows quota back, and only then", () =>
      Effect.gen(function* () {
        const { spent, read } = yield* spentAccount(reading(30));
        expect(yield* spent()).toBe(10 * HOUR);
        yield* read(reading(100));
        expect(yield* spent()).toBe(10 * HOUR);
        yield* read(reading(20));
        expect(yield* spent()).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    // fork: a reading that lacks a window says nothing about it, so it cannot bring the account back.
    it.effect("keeps a spent mark when the new reading is missing a window the old one had", () =>
      Effect.gen(function* () {
        const { spent, read } = yield* spentAccount(bothGroups(40, 100));
        // Only Gemini comes back, at 10%: the Claude & GPT window that ran out is not in it.
        yield* read(reading(10));
        expect(yield* spent()).toBe(10 * HOUR);
        // A window that is still spent keeps it, and one that is complete and under 100% clears it.
        yield* read(bothGroups(10, 100));
        expect(yield* spent()).toBe(10 * HOUR);
        yield* read(bothGroups(10, 60));
        expect(yield* spent()).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("does not count a window of another kind as the one that ran out", () =>
      Effect.gen(function* () {
        const { spent, read } = yield* spentAccount(bothGroups(40, 100));
        const other = bothGroups(10, 10);
        yield* read({
          ...other,
          windows: [other.windows[0]!, { ...other.windows[1]!, kind: "weekly" }],
        });
        expect(yield* spent()).toBe(10 * HOUR);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("keeps a spent mark when there is no earlier reading to compare with", () =>
      Effect.gen(function* () {
        const { spent, read } = yield* spentAccount();
        yield* read(reading(5));
        expect(yield* spent()).toBe(10 * HOUR);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect("gives a cancelled lease back with no verdict, and ignores a stale one", () =>
      Effect.gen(function* () {
        const { pool, a } = yield* twoAccounts();
        const first = (yield* pool.beginProbe(a.id))!;
        yield* pool.cancelProbe(first);
        expect((yield* pool.list).find((account) => account.id === a.id)?.probe).toEqual({
          lastAttemptAt: null,
          failures: 0,
          failure: null,
        });
        const second = (yield* pool.beginProbe(a.id))!;
        // A cancel of the old lease must not free the new one.
        yield* pool.cancelProbe(first);
        expect(yield* pool.beginProbe(a.id)).toBeUndefined();
        yield* pool.cancelProbe(second);
        expect(yield* pool.beginProbe(a.id)).toBeDefined();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    // fork: a restart must not start the backoff over, and a sign-in that works again ends it.
    it.effect("remembers how the reads went across a restart, until the account runs again", () =>
      Effect.gen(function* () {
        const { pool, a, b, acp, path } = yield* twoAccounts();
        yield* TestClock.adjust(5 * 60_000);
        const lease = (yield* pool.beginProbe(a.id))!;
        yield* pool.finishProbe(lease, { _tag: "Failed", reason: "expired" });
        const probeOf = (list: ReadonlyArray<AntigravityAccount>) =>
          list.find((account) => account.id === a.id)?.probe;
        const expected = {
          lastAttemptAt: 5 * 60_000,
          failures: 1,
          failure: { at: 5 * 60_000, reason: "expired" },
        };
        expect(probeOf(yield* pool.list)).toEqual(expected);
        const restarted = yield* makeAntigravityAccountPool(path.dirname(acp));
        expect(probeOf(yield* restarted.list)).toEqual(expected);
        // While the account is in use it carries no history; once it has been in use, none comes back.
        yield* restarted.select(a.id);
        expect(probeOf(yield* restarted.list)?.failures).toBe(0);
        yield* restarted.select(b.id);
        expect(probeOf(yield* restarted.list)?.failures).toBe(0);
        expect(
          probeOf(yield* (yield* makeAntigravityAccountPool(path.dirname(acp))).list)?.failures,
        ).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
});
