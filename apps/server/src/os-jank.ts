import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  buildEnvironmentCaptureCommand,
  extractEnvironmentValues,
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  readEnvironmentFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
  setWindowsPath,
  WindowsShellEnvironment,
} from "@t3tools/shared/shell";
import * as CliError from "effect/cli/CliError"; // fork: official home guard
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the shared login shell probe runs synchronously through execFileSync.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import { FORK, officialHomeDirectory, officialHomeRefusal } from "@t3tools/shared/forkIdentity"; // fork: identity

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

// __MISE_DIFF is mise's record of the PATH entries it added. It must travel
// with the shell's PATH, or `mise x` can rebuild PATH behind a same-named
// wrapper (`exec mise x claude -- claude`) that then re-runs itself forever.
const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "__MISE_DIFF",
  "FNM_MULTISHELL_PATH",
  "JAVA_HOME",
  "T3CODE_FEATURE_FLAGS",
] as const;
const LOGIN_SHELL_TIMEOUT = Duration.seconds(5);
const SLOW_LOGIN_SHELL_TIMEOUT_MS = 20_000;

function readSlowLoginShellEnvironment(shell: string): Partial<Record<string, string>> {
  return readEnvironmentFromLoginShell(shell, LOGIN_SHELL_ENV_NAMES, (file, args, options) =>
    NodeChildProcess.execFileSync(file, args, {
      ...options,
      timeout: SLOW_LOGIN_SHELL_TIMEOUT_MS,
    }),
  );
}

function applyLoginShellEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  shellEnvironment: Partial<Record<string, string>>,
  fallbackPath?: string,
): void {
  const shellPath = shellEnvironment.PATH;
  // fnm gives every probe shell its own multishell folder; drop the last probe's on a re-read.
  const multishell = shellPath ? shellEnvironment.FNM_MULTISHELL_PATH : undefined;
  const staleMultishell = multishell ? env.FNM_MULTISHELL_PATH : undefined;
  // The probe inherits our PATH, so the stale folder is in the shell's PATH too.
  const withoutStale = (path: string | undefined) =>
    staleMultishell && staleMultishell !== multishell
      ? path
          ?.split(":")
          .filter((entry) => entry !== staleMultishell && !entry.startsWith(`${staleMultishell}/`))
          .join(":")
      : path;
  const mergedPath = mergePathEntries(
    withoutStale(shellPath ?? fallbackPath),
    withoutStale(env.PATH),
    platform,
  );
  if (mergedPath) {
    env.PATH = mergedPath;
  }
  if (shellPath && shellEnvironment.__MISE_DIFF) {
    env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
  }
  if (multishell) {
    env.FNM_MULTISHELL_PATH = multishell;
  }
  // Android SDK tools are Java programs. A keg-only JDK (Homebrew's openjdk)
  // is only reachable through the JAVA_HOME the shell profile sets.
  if (!env.JAVA_HOME && shellEnvironment.JAVA_HOME) {
    env.JAVA_HOME = shellEnvironment.JAVA_HOME;
  }
  // A headless server (systemd, launchd) reads no profile, yet flags belong where users export them.
  if (env.T3CODE_FEATURE_FLAGS === undefined && shellEnvironment.T3CODE_FEATURE_FLAGS) {
    env.T3CODE_FEATURE_FLAGS = shellEnvironment.T3CODE_FEATURE_FLAGS;
  }
}

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  let shellEnvironment: Partial<Record<string, string>> = {};
  let waitedForSlowShell = false;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellEnvironment = readEnvironmentFromLoginShell(shell, LOGIN_SHELL_ENV_NAMES);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
      // A profile can be slow only while the machine boots. Wait for it once,
      // here: providers copy this env when they are built, so a later read
      // would never reach them.
      if (!waitedForSlowShell && (error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT") {
        waitedForSlowShell = true;
        try {
          shellEnvironment = readSlowLoginShellEnvironment(shell);
        } catch (retryError) {
          logPathHydrationWarning(
            `Failed to read PATH from slow login shell ${shell}.`,
            retryError,
          );
        }
      }
    }

    if (shellEnvironment.PATH) break;
  }

  const launchctlPath =
    platform === "darwin" && !shellEnvironment.PATH ? readPathFromLaunchctl() : undefined;
  applyLoginShellEnvironment(env, platform, shellEnvironment, launchctlPath);
}

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (options?: {
  readonly shellEnvironmentPrepared?: boolean | undefined;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;

  if (platform === "win32") {
    // Desktop already populated the child env; repeating PowerShell probes costs seconds.
    if (options?.shellEnvironmentPrepared === true) return;
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value === undefined) continue;
      if (key === "PATH") {
        setWindowsPath(env, value);
      } else {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  if (options?.shellEnvironmentPrepared === true) return;
  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

const readLoginShellOutput = Effect.fn("readLoginShellOutput")(
  function* (shell: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        shell,
        ["-ilc", buildEnvironmentCaptureCommand(shell, LOGIN_SHELL_ENV_NAMES)],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          // A profile that traps SIGTERM would otherwise hold the scope open
          // past the timeout while cleanup waits for the exit.
          forceKillAfter: "1 second",
        },
      ),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
      { concurrency: 2 },
    );
    if (exitCode === 0) return stdout;
    yield* Effect.logWarning(
      `Login shell ${shell} exited with code ${exitCode} while reading PATH.`,
    );
    return "";
  },
  Effect.scoped,
  Effect.timeoutOption(LOGIN_SHELL_TIMEOUT),
);

// Runs even when the desktop prepared the environment: that capture was taken
// once at launch. Only the user's own shell counts; a fallback shell's PATH is
// not their environment. Failure leaves PATH alone.
export const refreshPathFromLoginShell = Effect.fn("refreshPathFromLoginShell")(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "darwin" && platform !== "linux") return;
  const env = yield* HostProcess.Environment;
  const [shell] = listLoginShellCandidates(platform, env.SHELL);
  if (!shell) return;

  const output = yield* readLoginShellOutput(shell).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Failed to read PATH from login shell ${shell}.`, cause).pipe(
        Effect.as(Option.some("")),
      ),
    ),
  );
  if (Option.isNone(output)) {
    yield* Effect.logWarning(
      `Timed out reading PATH from login shell ${shell} after ${Duration.format(LOGIN_SHELL_TIMEOUT)}; PATH is unchanged.`,
    );
    return;
  }
  const shellEnvironment = extractEnvironmentValues(output.value, LOGIN_SHELL_ENV_NAMES);
  if (shellEnvironment.PATH) {
    applyLoginShellEnvironment(env, platform, shellEnvironment);
  } else {
    yield* Effect.logWarning(`Login shell ${shell} printed no PATH; PATH is unchanged.`);
  }
});

// Installers write PATH to the registry, which the server's launch-time PATH never sees again.
// Returns whether PATH gained a directory.
export const refreshWindowsPath = Effect.fn("refreshWindowsPath")(function* () {
  if ((yield* HostProcess.Platform) !== "win32") return false;
  const env = yield* HostProcess.Environment;
  const readEnvironment = yield* WindowsShellEnvironment;
  const { PATH: registryPath } = yield* readEnvironment(["PATH"], { loadProfile: false });
  const currentPath = env.PATH ?? env.Path ?? env.path;
  const mergedPath = mergePathValues(currentPath, registryPath, "win32");
  if (!mergedPath || mergedPath === currentPath) return false;
  setWindowsPath(env, mergedPath);
  return true;
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
});

// fork: T3 Extend never uses official T3 Code's T3 home as its own, however it was named.
// A missing path is compared by its nearest real ancestor, so a link into the official home is
// caught before anything creates it. Only the home itself is refused: a dev worktree's own
// state directory legitimately sits below it.
const refuseOfficialHome = Effect.fn("refuseOfficialHome")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const official = officialHomeDirectory(yield* HostProcess.HomeDirectory, path.join);
  const caseInsensitive = platform === "darwin" || platform === "win32";
  const realLocation = (target: string): Effect.Effect<string> =>
    fs.realPath(target).pipe(
      Effect.catch(() => {
        const parent = path.dirname(target);
        return parent === target
          ? Effect.succeed(target)
          : Effect.map(realLocation(parent), (real) => path.join(real, path.basename(target)));
      }),
    );
  const keys = Effect.fn("refuseOfficialHome.keys")(function* (target: string) {
    const resolved = path.resolve(target);
    return [resolved, yield* realLocation(resolved)].map((candidate) =>
      caseInsensitive ? candidate.normalize("NFC").toLowerCase() : candidate,
    );
  });
  const officialKeys = yield* keys(official);
  if ((yield* keys(baseDir)).some((key) => officialKeys.includes(key))) {
    return yield* new CliError.UserError({
      cause: officialHomeRefusal(baseDir, official),
    });
  }
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  const baseDir =
    !raw || raw.trim().length === 0
      ? join(yield* HostProcess.HomeDirectory, FORK.homeDirName) // fork: own T3 home
      : resolve(yield* expandHomePath(raw.trim()));
  yield* refuseOfficialHome(baseDir); // fork: official home guard
  return baseDir;
});
