import type {
  BackgroundServiceChange,
  BackgroundServiceState,
} from "@t3tools/shared/backgroundService";
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
  backgroundServiceState,
  launchAgentPlistPath,
  launchdServiceTarget,
  parseCliServiceStatus,
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

// A launch agent that runs the app itself, so T3 Extend outlives the app. One server owns a T3 home
// and the app's server carries desktop-only channels, so the app stops the service while open.
export class DesktopBackgroundService extends Context.Service<
  DesktopBackgroundService,
  {
    readonly getState: Effect.Effect<BackgroundServiceState>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<BackgroundServiceChange>;
    /** At launch: stop the installed service so this app's server can own the T3 home. */
    readonly pauseForApp: Effect.Effect<void>;
    /** At quit, after the app's server stopped: start the installed service again. */
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

  /** The service this app installed runs the app itself; a plist for anything else is not ours to pause. */
  const installedFromApp = fs.readFileString(plistPath).pipe(
    Effect.map((plist) => plist.includes("<key>ELECTRON_RUN_AS_NODE</key>")),
    Effect.orElseSucceed(() => false),
  );

  const launchctl = (args: ReadonlyArray<string>, timeout = LAUNCHCTL_TIMEOUT) =>
    input.runCommand({ command: "launchctl", args, timeout });

  const getState = Effect.gen(function* () {
    if (!available) return { kind: "unavailable" } as const;
    const result = yield* runCli(["service", "status", "--json"], STATUS_TIMEOUT);
    return backgroundServiceState(
      result.code === 0 ? parseCliServiceStatus(result.stdout) : undefined,
    );
  }).pipe(Effect.withSpan("desktop.backgroundService.getState"));

  const pauseForApp = Effect.gen(function* () {
    if (!available || !(yield* installedFromApp)) return;
    // Not loaded is fine: bootout then fails and there is nothing to stop.
    const stopped = yield* launchctl(["bootout", "--wait", target], STOP_TIMEOUT);
    yield* Effect.logInfo("paused the background service for the app", {
      exitCode: stopped.code,
    });
  }).pipe(Effect.withSpan("desktop.backgroundService.pauseForApp"));

  const resumeAfterApp = Effect.gen(function* () {
    if (!available || !(yield* installedFromApp)) return;
    const loaded = (yield* launchctl(["print", target])).code === 0;
    // A loaded service idles while the app owns the home; restarting it takes the home now.
    const started = loaded
      ? yield* launchctl(["kickstart", "-k", target])
      : yield* launchctl(["enable", target]).pipe(
          Effect.andThen(launchctl(["bootstrap", `gui/${input.uid}`, plistPath])),
        );
    if (started.code !== 0) {
      yield* Effect.logWarning("could not start the background service after the app quit", {
        detail: lastLine(started),
      });
    }
  }).pipe(Effect.withSpan("desktop.backgroundService.resumeAfterApp"));

  const setEnabled = Effect.fn("desktop.backgroundService.setEnabled")(function* (
    enabled: boolean,
  ) {
    if (!available) return { state: { kind: "unavailable" }, error: null } as const;
    const result = yield* runCli(["service", enabled ? "install" : "uninstall"], CLI_TIMEOUT);
    // The install starts the service, which then waits for this app to release the home.
    if (enabled && result.code === 0) yield* pauseForApp;
    return { state: yield* getState, error: result.code === 0 ? null : lastLine(result) };
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
