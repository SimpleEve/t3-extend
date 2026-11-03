// fork: which frpc this computer runs (design Q7). Only `T3X_FRPC_PATH` then `<T3 home>/bin/frpc` are
// looked at, never PATH. The file and its directory must belong to this user or root and not be
// writable by others (off Windows), and it must print exactly the pinned version before it runs.
// The first of the two that passes is used; one that exists but fails does not hide the other.
import { FRP_MIRROR_ENV, FRP_VERSION, type FrpArchive } from "@t3tools/shared/forkFrp";
import { checkFrpcVersion, fetchFrpc, FrpFetchError } from "@t3tools/shared/forkFrpFetch";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";

const FRPC_PATH_ENV = "T3X_FRPC_PATH";

export class FrpBinaryError extends Schema.TaggedError<FrpBinaryError>()("FrpBinaryError", {
  problem: Schema.Literals([
    "not-found",
    "not-runnable",
    "wrong-version",
    "unsafe-location",
    "unsupported-platform",
    "download-failed",
    "checksum-mismatch",
    "extract-failed",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface LocatedFrpc {
  readonly path: string;
  readonly source: "T3X_FRPC_PATH" | "t3-home";
}

export class FrpBinary extends Context.Service<
  FrpBinary,
  {
    /** Where `install` puts it. */
    readonly homePath: Effect.Effect<string>;
    /** The first of the two places whose file passes the owner, permission and version checks. */
    readonly locate: Effect.Effect<LocatedFrpc, FrpBinaryError>;
    /** Downloads the pinned release into `<T3 home>/bin`, SHA-256 checked, then version-checks it. */
    readonly install: Effect.Effect<
      { readonly path: string; readonly url: string; readonly sha256: string },
      FrpBinaryError
    >;
  }
>()("t3/fork/deviceKeys/frpBinary") {}

/** Tests only: expect this archive instead of the pinned one. */
export interface FrpBinaryTestSeams {
  readonly entry?: FrpArchive;
}

const make = Effect.fn("FrpBinary.make")(function* (seams: FrpBinaryTestSeams) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  const arch = yield* HostProcess.Architecture;

  // Read once, with the config provider the layer was built under.
  const optionalEnv = (name: string) =>
    Config.String(name).pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  const fromEnv = yield* optionalEnv(FRPC_PATH_ENV);
  const mirror = yield* optionalEnv(FRP_MIRROR_ENV);

  const homePath = Effect.succeed(
    path.join(config.baseDir, "bin", platform === "win32" ? "frpc.exe" : "frpc"),
  );

  // POSIX ownership and mode bits mean nothing on Windows, where the check is skipped.
  const untrusted = Effect.fn("FrpBinary.untrusted")(function* (candidate: string) {
    if (platform === "win32") return Option.none<string>();
    const real = yield* fs.realPath(candidate);
    for (const target of [real, path.dirname(real)]) {
      const info = yield* fs.stat(target);
      const owner = Option.getOrUndefined(info.uid);
      if (owner !== undefined && owner !== userId && owner !== 0) {
        return Option.some(`${target} belongs to another user (uid ${owner})`);
      }
      if ((info.mode & 0o022) !== 0) {
        return Option.some(
          `${target} can be changed by other users (mode ${(info.mode & 0o777).toString(8)})`,
        );
      }
    }
    return Option.none<string>();
  });

  // What the person can do that actually works. A bad T3X_FRPC_PATH never blocks <T3 home>/bin/frpc,
  // so an install puts a usable copy where `locate` looks next.
  const remedy = (source: LocatedFrpc["source"], home: string) =>
    source === "T3X_FRPC_PATH"
      ? `Run \`t3x devices tunnel install\` to use a copy in ${home} instead, or fix that file.`
      : "Run `t3x devices tunnel install`.";

  const verified = (candidate: string, source: LocatedFrpc["source"], home: string) =>
    Effect.promise(() => checkFrpcVersion(candidate)).pipe(
      Effect.flatMap((check) =>
        check.ok
          ? Effect.succeed<LocatedFrpc>({ path: candidate, source })
          : Effect.fail(
              new FrpBinaryError({
                problem: check.reason,
                detail:
                  check.reason === "wrong-version"
                    ? `${candidate} reports frpc ${check.found || "an unknown version"}, but ${FRP_VERSION} is required. ${remedy(source, home)}`
                    : `${candidate} could not be run. ${remedy(source, home)}`,
              }),
            ),
      ),
    );

  // Checks one existing file: ownership and permissions first, then the version it prints.
  const attempt = Effect.fn("FrpBinary.attempt")(function* (
    candidate: string,
    source: LocatedFrpc["source"],
    home: string,
  ) {
    const reason = yield* untrusted(candidate).pipe(
      Effect.orElseSucceed(() => Option.some(`${candidate} could not be inspected`)),
    );
    if (Option.isSome(reason)) {
      return yield* new FrpBinaryError({
        problem: "unsafe-location",
        detail:
          source === "T3X_FRPC_PATH"
            ? `${candidate} was not run: ${reason.value}. Run \`t3x devices tunnel install\` to use a copy in ${home} instead, or fix its owner and permissions.`
            : `${candidate} was not run: ${reason.value}. Fix its owner and permissions, or remove it and run \`t3x devices tunnel install\`.`,
      });
    }
    return yield* verified(candidate, source, home);
  });

  const locate = Effect.gen(function* () {
    const home = yield* homePath;
    const candidates: ReadonlyArray<readonly [string, LocatedFrpc["source"]]> = [
      ...Option.match(fromEnv, {
        onNone: () => [],
        onSome: (value) => (value.trim() === "" ? [] : [[value, "T3X_FRPC_PATH"] as const]),
      }),
      [home, "t3-home"],
    ];
    // A file that fails its checks does not stop the next candidate: the app bundle can belong to
    // another account on a shared Mac while the user's own <T3 home>/bin/frpc is fine.
    const failures: Array<FrpBinaryError> = [];
    for (const [index, [candidate, source]] of candidates.entries()) {
      if (!(yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))) continue;
      const outcome = yield* Effect.result(attempt(candidate, source, home));
      if (outcome._tag === "Success") return outcome.success;
      failures.push(outcome.failure);
      if (index < candidates.length - 1) {
        yield* Effect.logWarning(`Skipping frpc: ${outcome.failure.detail}`);
      }
    }
    // The first candidate's problem is the one the person can act on; later ones are what the
    // fall-through already tried.
    const [first] = failures;
    if (first !== undefined) return yield* first;
    return yield* new FrpBinaryError({
      problem: "not-found",
      detail: `frpc was not found (looked at ${FRPC_PATH_ENV} and ${home}). Run \`t3x devices tunnel install\`.`,
    });
  }).pipe(Effect.withSpan("FrpBinary.locate"));

  const install = Effect.gen(function* () {
    const home = yield* homePath;
    const fetched = yield* Effect.tryPromise({
      try: () =>
        fetchFrpc({
          platform,
          arch,
          destination: path.dirname(home),
          baseUrl: Option.getOrUndefined(mirror),
          ...(seams.entry === undefined ? {} : { entry: seams.entry }),
        }),
      catch: (cause) =>
        cause instanceof FrpFetchError
          ? new FrpBinaryError({ problem: cause.problem, detail: cause.message })
          : new FrpBinaryError({ problem: "download-failed", detail: "The download failed." }),
    });
    yield* verified(fetched.path, "t3-home", home);
    return fetched;
  }).pipe(Effect.withSpan("FrpBinary.install"));

  return FrpBinary.of({ homePath, locate, install });
});

export const layer = (seams: FrpBinaryTestSeams = {}) => Layer.effect(FrpBinary, make(seams));
