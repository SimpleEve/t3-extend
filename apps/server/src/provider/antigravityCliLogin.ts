import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// fork: the agy CLI keeps its Google sign-in in the system keyring. Limits for an instance that
// shares that login read it from there, read-only; nothing is ever written back.

export interface AntigravityCliLogin {
  readonly accessToken: string;
  /** Only used to tell accounts apart; the access token is what authorizes requests. */
  readonly refreshToken: string | undefined;
  readonly expiresAt: number;
}

export type AntigravityCliLoginRead =
  | { readonly _tag: "found"; readonly login: AntigravityCliLogin }
  /** The keyring holds no agy sign-in. */
  | { readonly _tag: "missing" }
  /** The keyring refused, timed out, or held something this reader does not understand. */
  | { readonly _tag: "unreadable" };

const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
/** `security` exits 44 when no item matches. */
const SECURITY_ITEM_NOT_FOUND = 44;
/** Long enough to answer a keychain prompt; the prompt hangs the command until then. */
const KEYCHAIN_READ_TIMEOUT = "25 seconds";
const KEYCHAIN_MAX_CHUNKS = 64;
/** An access token this close to its expiry is treated as expired. */
export const CLI_LOGIN_EXPIRY_MARGIN_MS = 60_000;
/** A fresh answer is shared by every instance, so a re-login to another account shows within this. */
const SHARED_READ_REUSE_MS = 30_000;
/** A refusal, an unreadable item, or an expired token is not asked again sooner than this. */
const SHARED_BACKOFF_MS = 2 * 60_000;

const KeychainLogin = Schema.Struct({
  token: Schema.Struct({
    access_token: Schema.NonEmptyString,
    refresh_token: Schema.optional(Schema.String),
    expiry: Schema.NonEmptyString,
  }),
});
const decodeKeychainLogin = Schema.decodeUnknownOption(Schema.fromJsonString(KeychainLogin));

/**
 * The agy CLI stores `go-keyring-base64:` plus base64 of
 * `{"token":{"access_token","refresh_token","expiry",…},…}`. Plain JSON is accepted too.
 */
export function decodeAntigravityKeychainValue(value: string): AntigravityCliLogin | undefined {
  const text = value.trim();
  const json = text.startsWith(GO_KEYRING_BASE64_PREFIX)
    ? Buffer.from(text.slice(GO_KEYRING_BASE64_PREFIX.length), "base64").toString("utf8")
    : text;
  const decoded = decodeKeychainLogin(json);
  if (Option.isNone(decoded)) return undefined;
  const { access_token, refresh_token, expiry } = decoded.value.token;
  const expiresAt = DateTime.make(expiry);
  if (Option.isNone(expiresAt)) return undefined;
  return {
    accessToken: access_token,
    refreshToken: refresh_token || undefined,
    expiresAt: DateTime.toEpochMillis(expiresAt.value),
  };
}

/** The macOS login keychain. Other platforms have no reader. */
export const makeAntigravityCliLoginReader = (input: {
  readonly platform: NodeJS.Platform;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): Effect.Effect<AntigravityCliLoginRead> | undefined => {
  if (input.platform !== "darwin") return undefined;
  return Effect.gen(function* () {
    const child = yield* input.spawner.spawn(
      ChildProcess.make(
        "/usr/bin/security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
        { stdin: "ignore", stderr: "ignore", killSignal: "SIGKILL" },
      ),
    );
    const output = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.take(KEYCHAIN_MAX_CHUNKS),
      Stream.mkString,
    );
    const exitCode = yield* child.exitCode;
    if (exitCode === SECURITY_ITEM_NOT_FOUND) return { _tag: "missing" } as const;
    if (exitCode !== 0) return { _tag: "unreadable" } as const;
    const login = decodeAntigravityKeychainValue(output);
    return login ? ({ _tag: "found", login } as const) : ({ _tag: "unreadable" } as const);
  }).pipe(
    // Leaving the scope stops `security`, which also dismisses a keychain prompt nobody answered.
    Effect.scoped,
    Effect.timeout(KEYCHAIN_READ_TIMEOUT),
    Effect.orElseSucceed(() => ({ _tag: "unreadable" }) as const),
    Effect.withSpan("AntigravityCliLogin.readKeychain"),
  );
};

interface SharedAnswer {
  readonly read: AntigravityCliLoginRead;
  readonly at: number;
  readonly reuseMs: number;
}

const reuseMsFor = (read: AntigravityCliLoginRead, at: number) => {
  if (read._tag === "unreadable") return SHARED_BACKOFF_MS;
  if (read._tag === "missing") return SHARED_READ_REUSE_MS;
  const validFor = read.login.expiresAt - CLI_LOGIN_EXPIRY_MARGIN_MS - at;
  // Past its expiry the token is only worth asking about again after agy has had time to renew it.
  return validFor <= 0 ? SHARED_BACKOFF_MS : Math.min(SHARED_READ_REUSE_MS, validFor);
};

/**
 * One keychain item serves every instance, so the read is shared: concurrent callers wait on one
 * read, and its answer is reused for a while (longer after a failure, so a prompt nobody answered
 * does not come back at every health check). Each cache is its own; the driver uses one per process.
 */
export const makeSharedAntigravityCliLoginRead = () => {
  let pending: Deferred.Deferred<AntigravityCliLoginRead> | undefined;
  let answered: SharedAnswer | undefined;
  return Effect.fn("AntigravityCliLogin.sharedRead")(function* (
    read: Effect.Effect<AntigravityCliLoginRead>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const mine = yield* Deferred.make<AntigravityCliLoginRead>();
    // No yield between the checks and `pending = mine`, so two callers never both read.
    if (pending) return yield* Deferred.await(pending);
    if (answered && now >= answered.at && now - answered.at < answered.reuseMs) {
      return answered.read;
    }
    pending = mine;
    return yield* read.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          // An interrupted read answers `unreadable` to its waiters but is not kept.
          const outcome: AntigravityCliLoginRead = Exit.isSuccess(exit)
            ? exit.value
            : { _tag: "unreadable" };
          if (Exit.isSuccess(exit)) {
            const at = yield* Clock.currentTimeMillis;
            answered = { read: outcome, at, reuseMs: reuseMsFor(outcome, at) };
          }
          pending = undefined;
          yield* Deferred.succeed(mine, outcome);
        }),
      ),
    );
  });
};

export type SharedAntigravityCliLoginRead = ReturnType<typeof makeSharedAntigravityCliLoginRead>;

/**
 * How the driver reads the agy CLI sign-in. The default is one read per process, shared by every
 * instance; tests replace it to count reads or to stand in for another platform.
 */
export const AntigravityCliLoginSource = Context.Reference<{
  /** Overrides the host platform when the reader is chosen. */
  readonly platform: NodeJS.Platform | undefined;
  readonly share: SharedAntigravityCliLoginRead;
}>("@t3tools/server/provider/AntigravityCliLoginSource", {
  defaultValue: (() => {
    const source = { platform: undefined, share: makeSharedAntigravityCliLoginRead() };
    return () => source;
  })(),
});
