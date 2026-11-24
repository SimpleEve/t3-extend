import type * as Undici from "undici";
import type { AntigravitySettings } from "@t3tools/contracts";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAntigravityAcpRuntime } from "./acp/AntigravityAcpSupport.ts";
import type {
  AntigravityAccount,
  AntigravityAccountPool,
  AntigravityProbeFailureReason,
  AntigravityProbeOutcome,
  AntigravityProbeResult,
} from "./antigravityAccountPool.ts";
import {
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  prepareAntigravityProfile,
  type AntigravityAuthConfig,
} from "./antigravityAuthSupport.ts";
import { makeAntigravityUsageProbe } from "./antigravityUsageLimits.ts";

// fork: the other saved accounts of an Antigravity instance are not read live, and Google gives their
// access tokens about an hour once agy stops using them. A background read renews one in a private
// copy of its token, reads its quota with the probe the current account uses, and saves both.

/** One account at most this often. Google can reset quota early, so a remembered reading goes stale. */
export const ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS = 45 * 60_000;
/** Server startup settles before the first read, so booting never starts agy for every account. */
export const ANTIGRAVITY_BACKGROUND_PROBE_START_DELAY_MS = 3 * 60_000;
/** How often the scheduler looks for an account that is due; each look reads at most one. */
export const ANTIGRAVITY_BACKGROUND_PROBE_TICK_MS = 60_000;
/** A dead sign-in stays dead until the account signs in again, so it is retried rarely. */
export const ANTIGRAVITY_BACKGROUND_PROBE_BACKOFF_CAP_MS = 6 * 60 * 60_000;
const ANTIGRAVITY_BACKGROUND_PROBE_TIMEOUT = Duration.seconds(60);

const reasonOf = (account: AntigravityAccount) => account.probe.failure?.reason ?? null;

/** When an account is next due: a fixed interval after its last reading, doubling after each failure. */
export function nextAntigravityProbeAt(account: AntigravityAccount): number {
  const { lastAttemptAt, failures } = account.probe;
  if (failures > 0 && lastAttemptAt !== null) {
    const wait =
      reasonOf(account) === "expired"
        ? ANTIGRAVITY_BACKGROUND_PROBE_BACKOFF_CAP_MS
        : Math.min(
            ANTIGRAVITY_BACKGROUND_PROBE_BACKOFF_CAP_MS,
            ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS * 2 ** (failures - 1),
          );
    return lastAttemptAt + wait;
  }
  // A reading taken while the account was in use counts, so a fresh one is not read again.
  const checkedAt = Date.parse(account.usageLimits?.checkedAt ?? "");
  const base = Math.max(lastAttemptAt ?? 0, Number.isFinite(checkedAt) ? checkedAt : 0);
  return base === 0 ? 0 : base + ANTIGRAVITY_BACKGROUND_PROBE_INTERVAL_MS;
}

/** The account most overdue for a read. Never the current one; ties keep the pool's order. */
export function pickNextAntigravityProbe(
  accounts: ReadonlyArray<AntigravityAccount>,
  now: number,
): string | undefined {
  let pick: { readonly id: string; readonly dueAt: number } | undefined;
  for (const account of accounts) {
    if (account.current) continue;
    const dueAt = nextAntigravityProbeAt(account);
    if (dueAt <= now && (pick === undefined || dueAt < pick.dueAt)) {
      pick = { id: account.id, dueAt };
    }
  }
  return pick?.id;
}

export interface AntigravityAccountProber {
  /** Reads one saved account that is not in use. Resolves to what became of the read. */
  readonly probe: (id: string) => Effect.Effect<AntigravityProbeResult | "skipped">;
  /** The manual refresh: one account when named, else every account that is not in use, one by one. */
  readonly refresh: (id?: string) => Effect.Effect<void, ProviderSetupError>;
  /** Looks for a due account every tick, forever. Reads at most one account per look. */
  readonly schedule: Effect.Effect<never>;
}

export const makeAntigravityAccountProber = Effect.fn("makeAntigravityAccountProber")(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly pool: Pick<AntigravityAccountPool, "list" | "beginProbe" | "finishProbe">;
    /** Renews a lent token and reads the account's quota. Never fails; a failure is an outcome. */
    readonly read: (token: string) => Effect.Effect<AntigravityProbeOutcome>;
    /** Runs once after each read that changed what the account list shows. */
    readonly onProbed: Effect.Effect<void>;
  }) {
    // One agy at a time, however the read was asked for.
    const turn = yield* Semaphore.make(1);

    const probe: AntigravityAccountProber["probe"] = (id) =>
      turn.withPermits(1)(
        Effect.gen(function* () {
          const lease = yield* input.pool.beginProbe(id);
          if (lease === undefined) return "skipped" as const;
          const outcome = yield* input.read(lease.token).pipe(
            Effect.timeoutOption(ANTIGRAVITY_BACKGROUND_PROBE_TIMEOUT),
            Effect.map((result): AntigravityProbeOutcome =>
              result._tag === "Some" ? result.value : { _tag: "Failed", reason: "timeout" },
            ),
            // An interrupted read still gives the token back.
            Effect.onInterrupt(() =>
              input.pool.finishProbe(lease, { _tag: "Failed", reason: "failed" }),
            ),
          );
          const result = yield* input.pool.finishProbe(lease, outcome);
          if (result !== "discarded") yield* input.onProbed;
          return result;
        }),
      );

    const refresh: AntigravityAccountProber["refresh"] = Effect.fn(
      "AntigravityAccountProber.refresh",
    )(function* (id) {
      const accounts = yield* input.pool.list;
      if (id !== undefined && !accounts.some((account) => account.id === id)) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "refreshAccounts",
          detail: "Unknown Antigravity account.",
        });
      }
      for (const account of accounts) {
        if (account.current || (id !== undefined && account.id !== id)) continue;
        yield* probe(account.id);
      }
    });

    const schedule = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const id = pickNextAntigravityProbe(yield* input.pool.list, now);
      if (id !== undefined) yield* probe(id);
    }).pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(ANTIGRAVITY_BACKGROUND_PROBE_TICK_MS))),
      Effect.delay(Duration.millis(ANTIGRAVITY_BACKGROUND_PROBE_START_DELAY_MS)),
    ) as Effect.Effect<never>;

    return { probe, refresh, schedule } satisfies AntigravityAccountProber;
  },
);

/**
 * Starts the scheduler in the caller's scope, unless the instance should not read other accounts in
 * the background: it is disabled, or its setting is off. Manual refresh works either way.
 */
export const startAntigravityBackgroundProbe = (input: {
  readonly enabled: boolean;
  readonly settings: Pick<AntigravitySettings, "backgroundAccountCheck">;
  readonly prober: Pick<AntigravityAccountProber, "schedule">;
}): Effect.Effect<void, never, Scope.Scope> =>
  input.enabled && input.settings.backgroundAccountCheck
    ? Effect.forkScoped(input.prober.schedule).pipe(Effect.asVoid)
    : Effect.void;

const TOKEN_FILE = "antigravity-oauth-token";

type ReaderServices =
  | FileSystem.FileSystem
  | Path.Path
  | Digest.Digest
  | SecureRandom.SecureRandom
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

/**
 * Renews a copy of a saved token with `agy acp` and reads that account's quota. Only `initialize` and
 * `authenticate` are sent, so no session starts and no quota is used. Everything it makes lives in a
 * private directory that goes with the scope, and the agy it starts is stopped through its handle.
 */
export const makeAntigravityAccountReader = Effect.fn("makeAntigravityAccountReader")(
  function* (input: {
    readonly resolveExecutablePath: Effect.Effect<string, { readonly detail: string }>;
    readonly baseEnv: NodeJS.ProcessEnv;
    readonly auth: AntigravityAuthConfig;
    readonly userHome: string;
    /** Where the private directories go; the driver clears it at start, so a crash leaves nothing. */
    readonly tempRoot: string;
    readonly proxyDispatcher: Undici.Dispatcher | null | undefined;
  }) {
    const context = yield* Effect.context<ReaderServices>();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const failed = (): AntigravityProbeFailureReason => "failed";
    const removeQuietly = (directory: string) =>
      fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);

    const read = Effect.fn("AntigravityAccountReader.read")(function* (token: string) {
      const executablePath = yield* input.resolveExecutablePath.pipe(
        Effect.mapError((): AntigravityProbeFailureReason => "unavailable"),
      );
      yield* fs
        .makeDirectory(input.tempRoot, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(failed));
      const home = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: input.tempRoot, prefix: "probe-" }),
        removeQuietly,
      ).pipe(Effect.mapError(failed));
      const tokenPath = path.join(home, "antigravity-acp", TOKEN_FILE);
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(tokenPath, token, { mode: 0o600 });
        yield* fs.chmod(tokenPath, 0o600).pipe(Effect.ignore);
      }).pipe(Effect.mapError(failed));
      const profile = yield* prepareAntigravityProfile({
        profileDirectory: home,
        baseEnv: input.baseEnv,
        auth: input.auth,
        userHome: input.userHome,
        tempDirectory: input.tempRoot,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(failed),
      );
      const runtimeTemp = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: profile.tempDirectory, prefix: "run-" }),
        removeQuietly,
      ).pipe(Effect.mapError(failed));
      const spawn = buildAntigravityAcpSpawnInput({
        installation: { executablePath },
        profile,
        cwd: home,
        baseEnv: input.baseEnv,
        auth: input.auth,
        runtimeTempDirectory: runtimeTemp,
      });
      // Leaving this scope stops agy, whether the answer came or the read ran out of time.
      yield* Effect.gen(function* () {
        const runtime = yield* makeAntigravityAcpRuntime({
          cwd: home,
          mcpServers: [],
          childProcessSpawner: spawner,
          spawn,
          authMethod: input.auth.authMethod,
        });
        yield* runtime.authenticate?.(input.auth.authMethod) ?? Effect.void;
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause): AntigravityProbeFailureReason =>
          isAntigravitySignInRequiredError(cause) ? "expired" : "failed",
        ),
      );
      const renewed = yield* fs.readFileString(tokenPath).pipe(Effect.mapError(failed));
      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory: home,
        authMethod: input.auth.authMethod,
        proxyDispatcher: input.proxyDispatcher,
      });
      const limits = yield* usage.probe;
      return limits.unavailable !== undefined || limits.windows.length === 0
        ? ({ _tag: "Renewed", token: renewed, reason: "unavailable" } as const)
        : ({ _tag: "Read", token: renewed, limits } as const);
    });

    return (token: string): Effect.Effect<AntigravityProbeOutcome> =>
      read(token).pipe(
        Effect.scoped,
        Effect.catch((reason): Effect.Effect<AntigravityProbeOutcome> =>
          Effect.succeed({ _tag: "Failed", reason }),
        ),
        Effect.catchDefect((): Effect.Effect<AntigravityProbeOutcome> =>
          Effect.succeed({ _tag: "Failed", reason: "failed" }),
        ),
        Effect.provide(context),
      );
  },
);
