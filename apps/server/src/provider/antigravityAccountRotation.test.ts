import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import { makeAntigravityAccountPool } from "./antigravityAccountPool.ts";
import {
  makeAntigravityUsageLimitRecovery,
  antigravityServerAccounts,
  maskAntigravityEmail,
  withoutLiveReadingCopy,
} from "./antigravityAccountRotation.ts";

const token = (email: string) =>
  JSON.stringify({
    token: { access_token: `access-${email}`, refresh_token: `refresh-${email}` },
    id_token_email: email,
  });
const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const HOUR = 3_600_000;

const fixture = Effect.fn("AntigravityAccountRotationTest.fixture")(function* (
  emails: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profile = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(profile, "antigravity-acp"), { recursive: true });
  const current = path.join(profile, "antigravity-acp", "antigravity-oauth-token");
  const pool = yield* makeAntigravityAccountPool(profile);
  for (const email of emails) {
    yield* pool.beginAdd;
    yield* fs.writeFileString(current, token(email));
    yield* pool.settleAdd;
  }
  // The first account is the one in use.
  yield* pool.select((yield* pool.list)[0]!.id);
  return { pool, recover: makeAntigravityUsageLimitRecovery(pool) };
});

const quota = (resetAt: number | null) =>
  makeProviderFailure({
    class: "usage_limit",
    message: "You have reached your Antigravity quota for this period.",
    code: "QUOTA_EXHAUSTED",
    retryable: true,
    resetAt: resetAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(resetAt)),
  });

describe("Antigravity usage-limit recovery", () => {
  it("masks an email without hiding the domain", () => {
    expect(maskAntigravityEmail("someone@example.com")).toBe("s•••@example.com");
    expect(maskAntigravityEmail(null)).toBe("another account");
    expect(maskAntigravityEmail("no-at-sign")).toBe("another account");
  });

  it.effect("names the account that takes over, in a notice that hides the local part", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const { recover } = yield* fixture(["alice@example.com", "bob@example.com"]);
      const recovery = yield* recover(quota(1_000_000 + 2 * HOUR));
      expect(recovery).toBeDefined();
      const notice = recovery && "notice" in recovery ? recovery.notice : "";
      expect(notice).toContain("a•••@example.com used its Antigravity quota");
      expect(notice).toContain("Switched to b•••@example.com and continued this turn.");
      expect(notice).not.toContain("alice");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("fails with the earliest reset once every saved account is spent", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const { pool, recover } = yield* fixture(["alice@example.com", "bob@example.com"]);
      yield* recover(quota(1_000_000 + 3 * HOUR));
      yield* pool.ensureAvailable({ rotate: true });
      const recovery = yield* recover(quota(1_000_000 + HOUR));
      const failure = recovery && "failure" in recovery ? recovery.failure : undefined;
      expect(failure?.class).toBe("usage_limit");
      expect(failure?.message).toContain("Every saved Antigravity account");
      expect(failure?.resetAt).toBe(DateTime.formatIso(DateTime.makeUnsafe(1_000_000 + HOUR)));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "moves to the next saved account by the failure alone, with no quota reading ever taken",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000_000);
        const { pool, recover } = yield* fixture([
          "alice@example.com",
          "bob@example.com",
          "carol@example.com",
        ]);
        // Quota reading is off: nothing observed a reading, so the pool holds none.
        expect((yield* pool.list).map((account) => account.usageLimits)).toEqual([
          null,
          null,
          null,
        ]);
        const first = yield* recover(quota(1_000_000 + 2 * HOUR));
        expect(first && "notice" in first ? first.notice : "").toContain(
          "Switched to b•••@example.com",
        );
        yield* pool.ensureAvailable({ rotate: true });
        const second = yield* recover(quota(1_000_000 + 3 * HOUR));
        expect(second && "notice" in second ? second.notice : "").toContain(
          "b•••@example.com used its Antigravity quota",
        );
        expect(second && "notice" in second ? second.notice : "").toContain(
          "Switched to c•••@example.com",
        );
        expect((yield* pool.list).map((account) => account.usageLimits)).toEqual([
          null,
          null,
          null,
        ]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("leaves the plain failure alone when there is only one account", () =>
    Effect.gen(function* () {
      const { recover } = yield* fixture(["alice@example.com"]);
      expect(yield* recover(quota(null))).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("Antigravity provider account list", () => {
  const reading = (credentialFingerprint: string) => ({
    checkedAt: "2026-01-01T00:00:00.000Z",
    credentialFingerprint,
    windows: [{ id: "gemini-5h", kind: "session" as const, label: "Gemini", usedPercent: 40 }],
  });
  const saved = [
    { id: "a", email: "a@example.com", current: true, usageLimits: reading("fp-a") },
    { id: "b", email: "b@example.com", current: false, usageLimits: reading("fp-b") },
  ];
  const kept = (accounts: ReadonlyArray<{ readonly usageLimits?: unknown }>) =>
    accounts.map((account) => account.usageLimits !== undefined);

  it("leaves the current account's reading off while the live reading stands in for it", () => {
    expect(kept(withoutLiveReadingCopy(saved, reading("fp-a")))).toEqual([false, true]);
    // A reading taken before the instance had an identity still counts as the same account's.
    expect(
      kept(withoutLiveReadingCopy(saved, { ...reading("fp-a"), credentialFingerprint: undefined })),
    ).toEqual([false, true]);
  });

  it("sends it when there is no usable live reading, or the live reading is another account's", () => {
    const unreadable = {
      checkedAt: "2026-01-01T00:00:00.000Z",
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    };
    expect(kept(withoutLiveReadingCopy(saved, undefined))).toEqual([true, true]);
    expect(kept(withoutLiveReadingCopy(saved, unreadable))).toEqual([true, true]);
    expect(kept(withoutLiveReadingCopy(saved, reading("fp-other")))).toEqual([true, true]);
  });
});

describe("the accounts a snapshot lists", () => {
  it.effect("carries why the last background read of an account failed, until one works", () =>
    Effect.gen(function* () {
      const { pool } = yield* fixture(["a@example.com", "b@example.com"]);
      const [a] = yield* pool.list;
      yield* TestClock.adjust(HOUR);
      const lease = (yield* pool.beginProbe(
        (yield* pool.list).find((entry) => !entry.current)!.id,
      ))!;
      yield* pool.finishProbe(lease, { _tag: "Failed", reason: "expired" });
      const listed = yield* antigravityServerAccounts(pool, { readUsageLimits: true });
      expect(listed.find((account) => account.id === lease.id)?.usageProbeFailure).toEqual({
        at: DateTime.formatIso(DateTime.makeUnsafe(HOUR)),
        reason: "expired",
      });
      expect(listed.find((account) => account.id === a!.id)?.usageProbeFailure).toBeUndefined();
      // Only an account that is not in use can be read on request; the client shows the button on that.
      expect(listed.find((account) => account.id === lease.id)?.refreshable).toBe(true);
      expect(listed.find((account) => account.current)?.refreshable).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("lists no reading, refresh or read failure when quota reading is off", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const { pool, recover } = yield* fixture(["a@example.com", "b@example.com"]);
      const [current, other] = yield* pool.list;
      // Earlier, while reading was on: a remembered reading and a failed background read.
      yield* pool.observeUsage(
        Effect.succeed({
          checkedAt: "2026-01-01T00:00:00.000Z",
          windows: [
            { id: "gemini-5h", kind: "session" as const, label: "Gemini", usedPercent: 40 },
          ],
        }),
      );
      const lease = (yield* pool.beginProbe(other!.id))!;
      yield* pool.finishProbe(lease, { _tag: "Failed", reason: "expired" });
      yield* recover(quota(1_000_000 + 2 * HOUR));
      const on = yield* antigravityServerAccounts(pool, { readUsageLimits: true });
      expect(on.find((account) => account.id === current!.id)?.usageLimits).toBeDefined();
      expect(on.find((account) => account.id === other!.id)?.usageProbeFailure).toBeDefined();
      const off = yield* antigravityServerAccounts(pool, { readUsageLimits: false });
      for (const account of off) {
        expect(account.usageLimits).toBeUndefined();
        expect(account.usageProbeFailure).toBeUndefined();
        expect(account.refreshable).toBeUndefined();
      }
      // The account list itself, and which one ran out, stay: switching does not need a reading.
      expect(off.map((account) => account.id)).toEqual(on.map((account) => account.id));
      expect(off.find((account) => account.id === current!.id)?.exhaustedUntil).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
