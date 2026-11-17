import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
