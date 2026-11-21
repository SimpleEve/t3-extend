import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { makeAntigravityAccountPool } from "./antigravityAccountPool.ts";

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
      yield* pool.ensureAvailable({ rotate: true });
      expect(yield* readCurrent()).toBe(token("b@example.com"));
      expect((yield* pool.list).find((account) => account.current)?.email).toBe("b@example.com");
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
      yield* pool.ensureAvailable({ rotate: false });
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
