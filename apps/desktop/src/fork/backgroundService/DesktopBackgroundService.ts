import type {
  BackgroundServiceChange,
  BackgroundServiceState,
} from "@t3tools/shared/backgroundService";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { bundledFrpcPath } from "../../selfHost/bundledFrpc.ts";
import {
  type AppServicePlist,
  backgroundServiceState,
  launchAgentPlistPath,
  launchdServiceTarget,
  parseAppServicePlist,
  parseCliServiceStatus,
  parseResumeFailure,
  RESUME_FAILURE_FILE,
  sameAppService,
  splitAppBundle,
} from "./backgroundService.logic.ts";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeout: Duration.Duration;
}

/** Never fails: a command that could not start or ran out of time is a non-zero result. */
export type RunCommand = (input: CommandInput) => Effect.Effect<CommandResult>;

export type PauseResult =
  | { readonly kind: "skipped" }
  | { readonly kind: "stopped" }
  /** The service is still loaded after the stop, so a second server would collide with it. */
  | { readonly kind: "failed"; readonly reason: string };

// A launch agent that runs the app itself, so T3 Extend outlives the app. One server owns a T3 home
// and the app's server carries desktop-only channels, so the app stops the service while open.
export class DesktopBackgroundService extends Context.Service<
  DesktopBackgroundService,
  {
    readonly getState: Effect.Effect<BackgroundServiceState>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<BackgroundServiceChange>;
    /** At launch: stop this app's service so this app's server can own the T3 home. */
    readonly pauseForApp: Effect.Effect<PauseResult>;
    /**
     * At quit, after the app's server stopped: start this app's service again and check it
     * loaded. A start that still fails is recorded for the next launch to report.
     */
    readonly resumeAfterApp: Effect.Effect<void>;
  }
>()("@t3tools/desktop/fork/backgroundService/DesktopBackgroundService") {}

const CLI_TIMEOUT = Duration.seconds(120);
const STATUS_TIMEOUT = Duration.seconds(30);
// launchd waits up to the service's ExitTimeOut (90s) for it to stop.
const STOP_TIMEOUT = Duration.seconds(120);
const LAUNCHCTL_TIMEOUT = Duration.seconds(20);

/** The one line that says why a command failed. */
const lastLine = (result: CommandResult) =>
  `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? `exit code ${result.code}`;

export const make = Effect.fn("desktop.backgroundService.make")(function* (input: {
  readonly available: boolean;
  readonly homeDirectory: string;
  readonly uid: number | undefined;
  /** The app's executable and server entry: the same pair the `t3x` shim runs. */
  readonly cli: {
    readonly executable: string;
    readonly entry: string;
    readonly baseDir: string;
    readonly frpcPath: string;
  };
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly runCommand: RunCommand;
}) {
  const fs = yield* FileSystem.FileSystem;
  const plistPath = launchAgentPlistPath(input.homeDirectory);
  const available = input.available && input.uid !== undefined;
  const target = launchdServiceTarget(input.uid ?? 0);

  const runCli = (args: ReadonlyArray<string>, timeout: Duration.Duration) => {
    const inherited = Object.fromEntries(
      Object.entries(input.environment).flatMap(([name, value]) =>
        value === undefined || name === "T3_BOOT_SERVICE_UNIT" ? [] : [[name, value]],
      ),
    );
    return input.runCommand({
      command: input.cli.executable,
      args: [input.cli.entry, ...args, "--base-dir", input.cli.baseDir],
      env: {
        ...inherited,
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_HOME: input.cli.baseDir,
        T3X_FRPC_PATH: input.cli.frpcPath,
      },
      timeout,
    });
  };

  const canonical = (path: string) => {
    const split = splitAppBundle(path);
    return fs.realPath(split?.bundle ?? path).pipe(
      Effect.map((real) => (split === undefined ? real : `${real}${split.rest}`)),
      Effect.orElseSucceed(() => path),
    );
  };
  const canonicalService = (service: AppServicePlist) =>
    Effect.all({
      executable: canonical(service.executable),
      entry: canonical(service.entry),
      baseDir: canonical(service.baseDir),
    });

  /**
   * Only the service this very app installed for this very T3 home: its plist carries the app
   * service marker and names this app's program and entry and this home, links resolved. Another
   * home's service, another copy of the app, or an npm plist is never ours to stop or start.
   */
  const ownedService = Effect.gen(function* () {
    const parsed = parseAppServicePlist(yield* fs.readFileString(plistPath));
    if (parsed === undefined) return false;
    const current = yield* canonicalService({
      executable: input.cli.executable,
      entry: input.cli.entry,
      baseDir: input.cli.baseDir,
    });
    return sameAppService(yield* canonicalService(parsed), current);
  }).pipe(Effect.orElseSucceed(() => false));

  const launchctl = (args: ReadonlyArray<string>, timeout = LAUNCHCTL_TIMEOUT) =>
    input.runCommand({ command: "launchctl", args, timeout });
  const isLoaded = Effect.map(launchctl(["print", target]), (result) => result.code === 0);

  const failurePath = `${input.cli.baseDir}/runtime/${RESUME_FAILURE_FILE}`;
  const readFailure = fs.readFileString(failurePath).pipe(
    Effect.map(parseResumeFailure),
    Effect.orElseSucceed(() => undefined),
  );
  const clearFailure = fs.remove(failurePath, { force: true }).pipe(Effect.ignore);
  const recordFailure = Effect.fn("desktop.backgroundService.recordFailure")(function* (
    reason: string,
  ) {
    const at = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* fs.makeDirectory(`${input.cli.baseDir}/runtime`, { recursive: true });
    yield* fs.writeFileString(failurePath, `${JSON.stringify({ at, reason })}\n`, { mode: 0o600 });
  }, Effect.ignore);

  const getState = Effect.gen(function* () {
    if (!available) return { kind: "unavailable" } as const;
    const result = yield* runCli(["service", "status", "--json"], STATUS_TIMEOUT);
    const failure = yield* readFailure;
    const state = backgroundServiceState(
      result.code === 0 ? parseCliServiceStatus(result.stdout) : undefined,
      failure,
    );
    // A removed service has nothing left to retry.
    if (state.kind === "off" && failure !== undefined) yield* clearFailure;
    return state;
  }).pipe(Effect.withSpan("desktop.backgroundService.getState"));

  const pauseForApp = Effect.gen(function* () {
    if (!available || !(yield* ownedService) || !(yield* isLoaded)) {
      return { kind: "skipped" } as const;
    }
    const stopped = yield* launchctl(["bootout", "--wait", target], STOP_TIMEOUT);
    // Whatever bootout said, only a service that is gone has let go of the home.
    if (yield* isLoaded) {
      const reason = stopped.code === 0 ? "it is still loaded" : lastLine(stopped);
      yield* Effect.logWarning("the background service did not stop for the app", { reason });
      return { kind: "failed", reason } as const;
    }
    yield* Effect.logInfo("paused the background service for the app");
    return { kind: "stopped" } as const;
  }).pipe(Effect.withSpan("desktop.backgroundService.pauseForApp"));

  /** Starts the service and says why not when it is still not loaded afterwards. */
  const startService = Effect.fn("desktop.backgroundService.startService")(function* () {
    // A loaded service idles while the app owns the home; restarting it takes the home now.
    const started = (yield* isLoaded)
      ? yield* launchctl(["kickstart", "-k", target])
      : yield* launchctl(["enable", target]).pipe(
          Effect.andThen(launchctl(["bootstrap", `gui/${input.uid}`, plistPath])),
        );
    if (yield* isLoaded) return undefined;
    return started.code === 0 ? "it did not load" : lastLine(started);
  });

  const resumeAfterApp = Effect.gen(function* () {
    if (!available || !(yield* ownedService)) return;
    // One retry keeps a transient launchd refusal from stranding the service, and stays short.
    const failure = (yield* startService()) === undefined ? undefined : yield* startService();
    if (failure === undefined) {
      yield* clearFailure;
      return;
    }
    yield* Effect.logWarning("could not start the background service after the app quit", {
      reason: failure,
    });
    yield* recordFailure(failure);
  }).pipe(Effect.withSpan("desktop.backgroundService.resumeAfterApp"));

  const setEnabled = Effect.fn("desktop.backgroundService.setEnabled")(function* (
    enabled: boolean,
  ) {
    if (!available) return { state: { kind: "unavailable" }, error: null } as const;
    const result = yield* runCli(["service", enabled ? "install" : "uninstall"], CLI_TIMEOUT);
    let error = result.code === 0 ? null : lastLine(result);
    if (result.code === 0) {
      // A fresh install is a fresh start, and a removed service has nothing to retry.
      yield* clearFailure;
      // The install starts the service, which then waits for this app to release the home.
      if (enabled) {
        const paused = yield* pauseForApp;
        if (paused.kind === "failed") error = paused.reason;
      }
    }
    return { state: yield* getState, error };
  });

  return DesktopBackgroundService.of({ getState, setEnabled, pauseForApp, resumeAfterApp });
});

const decodeUtf8 = (chunks: ReadonlyArray<Uint8Array>) =>
  new TextDecoder("utf-8").decode(
    chunks.reduce((joined, chunk) => {
      const next = new Uint8Array(joined.length + chunk.length);
      next.set(joined);
      next.set(chunk, joined.length);
      return next;
    }, new Uint8Array()),
  );

const spawnRunner =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): RunCommand =>
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(input.command, input.args, {
            ...(input.env === undefined ? {} : { env: input.env, extendEnv: false }),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: Duration.seconds(5),
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return { code: Number(code), stdout: decodeUtf8(stdout), stderr: decodeUtf8(stderr) };
      }),
    ).pipe(
      Effect.timeoutOption(input.timeout),
      Effect.map(
        Option.getOrElse((): CommandResult => ({ code: 124, stdout: "", stderr: "timed out" })),
      ),
      Effect.catch((error) =>
        Effect.succeed<CommandResult>({ code: 127, stdout: "", stderr: error.message }),
      ),
    );

export const layer = Layer.effect(
  DesktopBackgroundService,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* make({
      available: environment.platform === "darwin" && environment.isPackaged,
      homeDirectory: environment.homeDirectory,
      uid: process.getuid?.(),
      cli: {
        executable: process.execPath,
        entry: environment.backendEntryPath,
        baseDir: environment.baseDir,
        frpcPath: bundledFrpcPath(
          environment.path,
          environment.resourcesPath,
          environment.platform,
        ),
      },
      environment: process.env,
      runCommand: spawnRunner(spawner),
    });
  }),
);
