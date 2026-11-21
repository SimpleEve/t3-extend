import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

// fork: several Google accounts inside one Antigravity instance's own profile. agy only ever reads
// and writes `antigravity-oauth-token`; the pool keeps one copy per account beside it and swaps the
// copy in. Accounts join only through agy's own `--login`, nothing is imported from elsewhere.

const TOKEN_FILE = "antigravity-oauth-token";
const STATE_FILE = "state.json";
const ACCOUNT_ID = /^[0-9a-f]{16}$/;
// A usage limit that names no reset time is treated as the length of agy's short window.
const DEFAULT_EXHAUSTED_MS = 5 * 60 * 60_000;

const TokenIdentity = Schema.Struct({
  id_token_email: Schema.optional(Schema.String),
  token: Schema.optional(
    Schema.Struct({
      refresh_token: Schema.optional(Schema.String),
    }),
  ),
});
const decodeTokenIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(TokenIdentity));

// Holds order and exhaustion only; never a credential.
const PoolState = Schema.Struct({
  version: Schema.Literal(1),
  order: Schema.Array(Schema.String),
  currentId: Schema.NullOr(Schema.String),
  exhaustedUntil: Schema.Record(Schema.String, Schema.Finite),
  /** When the current account last changed, so a failure from before then is not blamed on it. */
  currentSince: Schema.optional(Schema.Finite),
});
type PoolState = typeof PoolState.Type;
const decodePoolState = Schema.decodeUnknownOption(Schema.fromJsonString(PoolState));
const encodePoolState = Schema.encodeSync(Schema.fromJsonString(PoolState));

const emptyState = (): PoolState => ({
  version: 1,
  order: [],
  currentId: null,
  exhaustedUntil: {},
});

export class AntigravityAccountPoolError extends Schema.TaggedError<AntigravityAccountPoolError>()(
  "AntigravityAccountPoolError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface AntigravityAccount {
  readonly id: string;
  /** Absent only when the saved sign-in carries no email. */
  readonly email: string | null;
  readonly current: boolean;
  /** Epoch milliseconds until which the account's quota is spent; null when it is usable. */
  readonly exhaustedUntil: number | null;
}

export type AntigravityRotationPlan =
  | {
      readonly _tag: "Rotate";
      readonly from: { readonly email: string | null; readonly resetAt: number };
      readonly to: { readonly email: string | null };
    }
  /** Another turn already moved the instance on; the failed account was the one before. */
  | { readonly _tag: "Moved"; readonly to: { readonly email: string | null } }
  | { readonly _tag: "AllExhausted"; readonly earliestResetAt: number }
  | { readonly _tag: "NoAccount" };

export interface AntigravityAccountPool {
  readonly list: Effect.Effect<ReadonlyArray<AntigravityAccount>>;
  /** Moves the current sign-in into the pool and clears the way for `agy --login`. */
  readonly beginAdd: Effect.Effect<void, AntigravityAccountPoolError>;
  /** Registers whatever `--login` left as the current account, or restores the previous one. */
  readonly settleAdd: Effect.Effect<void, AntigravityAccountPoolError>;
  readonly select: (id: string) => Effect.Effect<void, AntigravityAccountPoolError>;
  readonly remove: (id: string) => Effect.Effect<void, AntigravityAccountPoolError>;
  /** Records the current account's spent quota and names the account that takes over. */
  readonly markExhausted: (
    resetAt?: number,
    /** When the failed prompt was sent; a change of account after it means another turn moved on. */
    promptSentAt?: number,
  ) => Effect.Effect<AntigravityRotationPlan>;
  /** Signing out leaves no saved account behind. */
  readonly clear: Effect.Effect<void, AntigravityAccountPoolError>;
  /**
   * Run before agy starts. Always restores the current account if a sign-in was cut short; with
   * `rotate`, also moves to the first usable account when the current one is spent. True when the
   * file agy reads now holds a different account than before.
   */
  readonly ensureAvailable: (options: {
    readonly rotate: boolean;
  }) => Effect.Effect<boolean, AntigravityAccountPoolError>;
}

interface Identity {
  readonly id: string;
  readonly email: string | null;
}

export const makeAntigravityAccountPool = Effect.fn("makeAntigravityAccountPool")(function* (
  profileDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const lock = yield* Semaphore.make(1);

  const acpDirectory = path.join(profileDirectory, "antigravity-acp");
  const currentPath = path.join(acpDirectory, TOKEN_FILE);
  const accountsDirectory = path.join(acpDirectory, "accounts");
  const statePath = path.join(accountsDirectory, STATE_FILE);
  const slotDirectory = (id: string) => path.join(accountsDirectory, id);
  const slotPath = (id: string) => path.join(slotDirectory(id), TOKEN_FILE);

  const poolError = (detail: string, cause?: unknown) =>
    new AntigravityAccountPoolError({ detail, ...(cause === undefined ? {} : { cause }) });

  const identify = Effect.fn("AntigravityAccountPool.identify")(function* (text: string) {
    const parsed = decodeTokenIdentity(text);
    if (Option.isNone(parsed)) return undefined;
    const email = parsed.value.id_token_email?.trim().toLowerCase() || null;
    const key = email ?? parsed.value.token?.refresh_token;
    if (!key) return undefined;
    const bytes = yield* digest.digest(
      Digest.sha256,
      new TextEncoder().encode(email === null ? `token\0${key}` : `email\0${key}`),
    );
    const id = Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { id, email } satisfies Identity;
  });

  const readText = (file: string) =>
    fs.readFileString(file).pipe(Effect.orElseSucceed((): string | undefined => undefined));

  /** Temp file and rename, so agy never reads a half-written token. */
  const writeAtomic = Effect.fn("AntigravityAccountPool.writeAtomic")(
    function* (file: string, text: string) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.t3-tmp`;
      yield* fs.writeFileString(temporary, text, { mode: 0o600 });
      yield* fs.chmod(temporary, 0o600).pipe(Effect.ignore);
      yield* fs
        .rename(temporary, file)
        .pipe(Effect.tapError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
    },
    Effect.mapError((cause) => poolError("Could not save the Antigravity account.", cause)),
  );

  const readState = Effect.gen(function* () {
    const text = yield* readText(statePath);
    if (text === undefined) return emptyState();
    // A damaged file counts as no pool; the next change writes a fresh one. Ids name directories.
    const state = Option.getOrElse(decodePoolState(text), emptyState);
    return {
      ...state,
      order: state.order.filter((id) => ACCOUNT_ID.test(id)),
      currentId:
        state.currentId !== null && ACCOUNT_ID.test(state.currentId) ? state.currentId : null,
    };
  });
  const writeState = (state: PoolState) => writeAtomic(statePath, `${encodePoolState(state)}\n`);

  const currentIdentity = Effect.gen(function* () {
    const text = yield* readText(currentPath);
    if (text === undefined) return undefined;
    const identity = yield* identify(text);
    return identity === undefined ? undefined : { ...identity, text };
  });

  const slotIdentity = Effect.fn("AntigravityAccountPool.slotIdentity")(function* (id: string) {
    const text = yield* readText(slotPath(id));
    if (text === undefined) return undefined;
    return yield* identify(text);
  });

  const withCurrent = Effect.fnUntraced(function* (state: PoolState, id: string | null) {
    if (state.currentId === id) return state;
    return { ...state, currentId: id, currentSince: yield* Clock.currentTimeMillis };
  });

  /** Brings the file agy last wrote into its slot, so a refreshed token is never lost. */
  const captureCurrent = Effect.fn("AntigravityAccountPool.captureCurrent")(function* (
    state: PoolState,
  ) {
    const current = yield* currentIdentity;
    if (current === undefined) return { state, current: undefined };
    yield* writeAtomic(slotPath(current.id), current.text);
    return {
      state: {
        ...(yield* withCurrent(state, current.id)),
        order: state.order.includes(current.id) ? state.order : [...state.order, current.id],
      },
      current,
    };
  });

  const install = Effect.fn("AntigravityAccountPool.install")(function* (id: string) {
    const text = yield* readText(slotPath(id));
    if (text === undefined || (yield* identify(text)) === undefined) {
      return yield* poolError("That Antigravity account is no longer saved. Add it again.");
    }
    yield* writeAtomic(currentPath, text);
  });

  const exhaustedAt = (state: PoolState, id: string, now: number) => {
    const until = state.exhaustedUntil[id];
    return until !== undefined && until > now ? until : null;
  };

  /** The accounts after `currentId`, in order and wrapping, that still have quota. */
  const nextUsable = (state: PoolState, currentId: string, now: number) => {
    const start = state.order.indexOf(currentId);
    const count = state.order.length;
    for (let step = 1; step < count; step++) {
      const id = state.order[(start + step) % count]!;
      if (exhaustedAt(state, id, now) === null) return id;
    }
    return undefined;
  };

  // Expired marks carry no information.
  const pruned = (state: PoolState, now: number): PoolState => ({
    ...state,
    exhaustedUntil: Object.fromEntries(
      Object.entries(state.exhaustedUntil).filter(
        ([id, until]) => until > now && state.order.includes(id),
      ),
    ),
  });

  const synchronized = <A, E>(effect: Effect.Effect<A, E>) => lock.withPermits(1)(effect);

  const list: AntigravityAccountPool["list"] = synchronized(
    Effect.gen(function* () {
      const state = yield* readState;
      const now = yield* Clock.currentTimeMillis;
      const current = yield* currentIdentity;
      const ids =
        current === undefined || state.order.includes(current.id)
          ? state.order
          : [...state.order, current.id];
      const accounts: Array<AntigravityAccount> = [];
      for (const id of ids) {
        const email = id === current?.id ? current.email : (yield* slotIdentity(id))?.email;
        accounts.push({
          id,
          email: email ?? null,
          current: id === current?.id,
          exhaustedUntil: exhaustedAt(state, id, now),
        });
      }
      return accounts;
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<AntigravityAccount> => [])),
  );

  const beginAdd: AntigravityAccountPool["beginAdd"] = synchronized(
    Effect.gen(function* () {
      const captured = yield* captureCurrent(yield* readState);
      if (captured.current === undefined) return;
      yield* writeState(captured.state);
      // agy would otherwise see a valid sign-in and skip the browser.
      yield* fs
        .remove(currentPath, { force: true })
        .pipe(
          Effect.mapError((cause) => poolError("Could not prepare Antigravity sign-in.", cause)),
        );
    }),
  );

  const settleAdd: AntigravityAccountPool["settleAdd"] = synchronized(
    Effect.gen(function* () {
      const state = yield* readState;
      const current = yield* currentIdentity;
      if (current !== undefined) {
        // The same account signing in again refreshes its slot instead of adding another.
        const captured = yield* captureCurrent(state);
        yield* writeState(captured.state);
        return;
      }
      // The sign-in did not finish: put the account that was current back.
      if (state.currentId !== null && state.order.includes(state.currentId)) {
        yield* install(state.currentId).pipe(Effect.ignore);
      }
    }),
  );

  const select: AntigravityAccountPool["select"] = (id) =>
    synchronized(
      Effect.gen(function* () {
        if (!ACCOUNT_ID.test(id)) return yield* poolError("Unknown Antigravity account.");
        const captured = yield* captureCurrent(yield* readState);
        if (!captured.state.order.includes(id)) {
          return yield* poolError("Unknown Antigravity account.");
        }
        yield* install(id);
        yield* writeState(yield* withCurrent(captured.state, id));
      }),
    );

  const remove: AntigravityAccountPool["remove"] = (id) =>
    synchronized(
      Effect.gen(function* () {
        if (!ACCOUNT_ID.test(id)) return yield* poolError("Unknown Antigravity account.");
        const now = yield* Clock.currentTimeMillis;
        const captured = yield* captureCurrent(yield* readState);
        const state = captured.state;
        if (!state.order.includes(id)) return yield* poolError("Unknown Antigravity account.");
        const remaining = state.order.filter((entry) => entry !== id);
        const base = pruned({ ...state, order: remaining }, now);
        if (captured.current?.id === id) {
          // The account in use goes: an account with quota takes over, then any other, else signed out.
          const next =
            nextUsable(state, id, now) ?? remaining[state.order.indexOf(id) % remaining.length];
          if (next === undefined) {
            yield* fs
              .remove(currentPath, { force: true })
              .pipe(Effect.mapError((cause) => poolError("Could not remove the account.", cause)));
            yield* writeState(yield* withCurrent(base, null));
          } else {
            yield* install(next);
            yield* writeState(yield* withCurrent(base, next));
          }
        } else {
          yield* writeState(base);
        }
        yield* fs
          .remove(slotDirectory(id), { recursive: true, force: true })
          .pipe(Effect.mapError((cause) => poolError("Could not remove the account.", cause)));
      }),
    );

  const markExhausted: AntigravityAccountPool["markExhausted"] = (resetAt, promptSentAt) =>
    synchronized(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const captured = yield* captureCurrent(yield* readState);
        const current = captured.current;
        if (current === undefined) return { _tag: "NoAccount" } as const;
        const until = resetAt !== undefined && resetAt > now ? resetAt : now + DEFAULT_EXHAUSTED_MS;
        // Several threads share the instance: one that failed on the old account must not mark
        // the account another thread has just switched to.
        const movedOn =
          promptSentAt !== undefined &&
          captured.state.currentSince !== undefined &&
          captured.state.currentSince > promptSentAt;
        const state = pruned(
          movedOn
            ? captured.state
            : {
                ...captured.state,
                exhaustedUntil: { ...captured.state.exhaustedUntil, [current.id]: until },
              },
          now,
        );
        yield* writeState(state);
        if (movedOn && exhaustedAt(state, current.id, now) === null) {
          return { _tag: "Moved", to: { email: current.email } } as const;
        }
        const next = nextUsable(state, current.id, now);
        if (next === undefined) {
          const earliest = Math.min(
            ...state.order.map((id) => exhaustedAt(state, id, now) ?? Number.POSITIVE_INFINITY),
          );
          return {
            _tag: "AllExhausted",
            earliestResetAt: Number.isFinite(earliest) ? earliest : until,
          } as const;
        }
        return {
          _tag: "Rotate",
          from: { email: current.email, resetAt: exhaustedAt(state, current.id, now) ?? until },
          to: { email: (yield* slotIdentity(next))?.email ?? null },
        } as const;
      }).pipe(Effect.orElseSucceed((): AntigravityRotationPlan => ({ _tag: "NoAccount" }))),
    );

  const clear: AntigravityAccountPool["clear"] = synchronized(
    Effect.gen(function* () {
      yield* fs.remove(accountsDirectory, { recursive: true, force: true });
      yield* fs.remove(currentPath, { force: true });
    }).pipe(Effect.mapError((cause) => poolError("Could not remove the saved accounts.", cause))),
  );

  const ensureAvailable: AntigravityAccountPool["ensureAvailable"] = ({ rotate }) =>
    synchronized(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const state = yield* readState;
        const current = yield* currentIdentity;
        if (current === undefined) {
          // A sign-in that never finished left no current file: bring the last account back.
          if (state.currentId !== null && state.order.includes(state.currentId)) {
            return yield* install(state.currentId).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
          }
          return false;
        }
        if (!rotate || exhaustedAt(state, current.id, now) === null) return false;
        const captured = yield* captureCurrent(state);
        const next = nextUsable(captured.state, current.id, now);
        if (next === undefined) return false;
        yield* install(next);
        yield* writeState(pruned(yield* withCurrent(captured.state, next), now));
        return true;
      }),
    );

  return {
    list,
    beginAdd,
    settleAdd,
    select,
    remove,
    markExhausted,
    clear,
    ensureAvailable,
  } satisfies AntigravityAccountPool;
});
