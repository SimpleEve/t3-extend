import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ManagedTunnelExit, ManagedTunnelState } from "@t3tools/shared/selfHost";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/**
 * Runs the user's tunnel client (for example `frpc -c ~/frpc.toml`) for as
 * long as the desktop app runs: restarts it with backoff when it exits, and
 * stops its whole process group when disabled or when the app quits. The
 * command comes only from this machine's desktop settings, never over RPC.
 */
export class ManagedTunnel extends Context.Service<
  ManagedTunnel,
  {
    readonly state: Effect.Effect<ManagedTunnelState>;
    readonly changes: Stream.Stream<ManagedTunnelState>;
    readonly configure: (input: {
      readonly command: string;
      readonly enabled: boolean;
    }) => Effect.Effect<ManagedTunnelState>;
    readonly restart: Effect.Effect<ManagedTunnelState>;
  }
>()("@t3tools/desktop/selfHost/ManagedTunnel") {}

const RESTART_BACKOFF_BASE_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 60_000;
// A client that stayed up this long was working; its next crash restarts quickly.
const RESTART_STABLE_UPTIME_MS = 30_000;
const RECENT_OUTPUT_LINES = 40;
const MAX_LINE_LENGTH = 300;
const MAX_ERROR_LENGTH = 500;
// The Node spawner fails `exitCode` only for a signal, naming it in the cause's message.
const SIGNAL_IN_MESSAGE = /signal: '([A-Z0-9]+)'/u;
const OUTPUT_DRAIN_TIMEOUT = Duration.seconds(1);

export const restartDelayMs = (previousDelayMs: number, uptimeMs: number): number =>
  uptimeMs >= RESTART_STABLE_UPTIME_MS || previousDelayMs === 0
    ? RESTART_BACKOFF_BASE_MS
    : Math.min(previousDelayMs * 2, RESTART_BACKOFF_MAX_MS);

// ESC [ ... final byte; built from a code point so the source has no control character.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "gu");

const cleanLine = (line: string): string =>
  line.replace(ANSI_ESCAPE, "").trimEnd().slice(0, MAX_LINE_LENGTH);

/** frpc logs `[E]`/`[W]`; most other clients say error, fatal, or refused. */
const isErrorOutput = (line: string): boolean =>
  /\[[EWF]\]|\b(?:error|fatal|panic|fail(?:ed|ure)?|refused|denied|unauthori[sz]ed)\b/iu.test(line);

/** frpc says `login to server success` and `start proxy success` once it reconnects. */
const isRecoveredOutput = (line: string): boolean => /\bsuccess\b/iu.test(line);

const shellCommand = (
  command: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ChildProcess.StandardCommand =>
  platform === "win32"
    ? ChildProcess.make(environment.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
    : // A login shell, so a GUI-launched app finds Homebrew and ~/.local binaries.
      ChildProcess.make(environment.SHELL || "/bin/sh", ["-lc", command], {
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(5),
      });

const stoppedState = (command: string, enabled: boolean): ManagedTunnelState => ({
  command,
  enabled,
  status: "stopped",
  pid: null,
  restarts: 0,
  lastError: null,
  lastExit: null,
  recentOutput: [],
});

const signalOf = (error: { readonly reason: { readonly cause?: unknown } }): string => {
  const cause = error.reason.cause;
  const match = cause instanceof Error ? SIGNAL_IN_MESSAGE.exec(cause.message) : null;
  return match?.[1] ?? "unknown";
};

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const scope = yield* Effect.scope;
  const stateRef = yield* SubscriptionRef.make(stoppedState("", false));
  const runner = yield* Ref.make<Fiber.Fiber<never> | null>(null);
  const permit = yield* Semaphore.make(1);

  const update = (f: (state: ManagedTunnelState) => ManagedTunnelState) =>
    SubscriptionRef.update(stateRef, f);

  const appendOutput = (line: string) =>
    update((state) => ({
      ...state,
      recentOutput: [...state.recentOutput, line].slice(-RECENT_OUTPUT_LINES),
      ...(isErrorOutput(line)
        ? { lastError: line.slice(0, MAX_ERROR_LENGTH) }
        : isRecoveredOutput(line)
          ? { lastError: null }
          : {}),
    }));

  const readLines = (stream: Stream.Stream<Uint8Array, unknown>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map(cleanLine),
      Stream.filter((line) => line.length > 0),
      Stream.runForEach(appendOutput),
      Effect.ignore,
    );

  // One child per attempt; closing the attempt's scope kills its process group.
  const runOnce = Effect.fn("desktop.managedTunnel.run")(function* (command: string) {
    // The spawn is this attempt's only failure; the child's own end is a ManagedTunnelExit.
    const child = yield* spawner.spawn(shellCommand(command, platform, environment));
    yield* update((state) => ({ ...state, status: "running", pid: Number(child.pid) }));
    const readers = [
      yield* Effect.forkScoped(readLines(child.stdout)),
      yield* Effect.forkScoped(readLines(child.stderr)),
    ];
    const exit = yield* child.exitCode.pipe(
      Effect.map((code): ManagedTunnelExit => ({ _tag: "exited", code: Number(code) })),
      Effect.catch((error) =>
        Effect.succeed<ManagedTunnelExit>({ _tag: "signaled", signal: signalOf(error) }),
      ),
    );
    // Keep the last lines it printed; a grandchild holding the pipe must not stall the restart.
    yield* Fiber.joinAll(readers).pipe(Effect.timeoutOption(OUTPUT_DRAIN_TIMEOUT));
    return exit;
  }, Effect.scoped);

  // Runs for the tunnel's whole enabled lifetime; each attempt has its own span.
  const supervise = Effect.fnUntraced(function* (command: string) {
    let delayMs = 0;
    for (;;) {
      yield* update((state) => ({
        ...state,
        status: "starting",
        pid: null,
        lastError: null,
        lastExit: null,
      }));
      const startedAt = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.exit(runOnce(command));
      const uptimeMs = (yield* Clock.currentTimeMillis) - startedAt;
      const lastExit: ManagedTunnelExit = Exit.isSuccess(exit)
        ? exit.value
        : { _tag: "spawn-failed" };
      delayMs = restartDelayMs(delayMs, uptimeMs);
      yield* update((state) => ({
        ...state,
        status: "backing-off",
        pid: null,
        restarts: state.restarts + 1,
        lastExit,
      }));
      yield* Effect.logWarning("managed tunnel exited; restarting", {
        uptimeMs,
        delayMs,
        exit: lastExit,
        ...(Exit.isFailure(exit) ? { cause: exit.cause } : {}),
      });
      yield* Effect.sleep(Duration.millis(delayMs));
    }
  });

  const stopRunner = Ref.getAndSet(runner, null).pipe(
    Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))),
  );

  const apply = Effect.gen(function* () {
    yield* stopRunner;
    const { command, enabled } = yield* SubscriptionRef.get(stateRef);
    yield* SubscriptionRef.set(stateRef, stoppedState(command, enabled));
    if (!enabled || command.trim().length === 0) return;
    const fiber = yield* Effect.forkIn(supervise(command), scope);
    yield* Ref.set(runner, fiber);
  });

  const configure = Effect.fn("desktop.managedTunnel.configure")(function* (input: {
    readonly command: string;
    readonly enabled: boolean;
  }) {
    yield* update((state) => ({ ...state, command: input.command, enabled: input.enabled }));
    yield* apply;
    return yield* SubscriptionRef.get(stateRef);
  }, permit.withPermit);

  const restart = permit
    .withPermit(apply.pipe(Effect.andThen(SubscriptionRef.get(stateRef))))
    .pipe(Effect.withSpan("desktop.managedTunnel.restart"));

  yield* Effect.addFinalizer(() => stopRunner);

  return ManagedTunnel.of({
    state: SubscriptionRef.get(stateRef),
    changes: SubscriptionRef.changes(stateRef),
    configure,
    restart,
  });
});

export const layer = Layer.effect(ManagedTunnel, make);
