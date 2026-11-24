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
  antigravityServerAccounts,
  makeAntigravityUsageLimitRecovery,
  maskAntigravityEmail,
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

  it.effect("leaves the plain failure alone when there is only one account", () =>
    Effect.gen(function* () {
      const { recover } = yield* fixture(["alice@example.com"]);
      expect(yield* recover(quota(null))).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("Antigravity provider account list", () => {
  it.effect("carries each account's remembered quota reading", () =>
    Effect.gen(function* () {
      const { pool } = yield* fixture(["a@example.com", "b@example.com"]);
      const reading = {
        checkedAt: "2026-01-01T00:00:00.000Z",
        windows: [{ id: "gemini-5h", kind: "session" as const, label: "Gemini", usedPercent: 40 }],
      };
      yield* pool.observeUsage(Effect.succeed(reading));
      const accounts = yield* antigravityServerAccounts(pool);
      expect(accounts.map((account) => account.usageLimits)).toEqual([reading, undefined]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
