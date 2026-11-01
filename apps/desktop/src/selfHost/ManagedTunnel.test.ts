import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ManagedTunnel from "./ManagedTunnel.ts";

interface FakeChild {
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  readonly killed: Deferred.Deferred<void>;
}

/** Each spawn hands its child to the test; closing the spawn scope marks it killed. */
const harness = Effect.gen(function* () {
  const children = yield* Queue.unbounded<FakeChild>();
  const commands = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const killed = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(killed, undefined));
      if (command._tag === "StandardCommand") {
        yield* Ref.update(commands, (all) => [...all, [command.command, ...command.args]]);
      }
      yield* Queue.offer(children, { exit, killed });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode("login to server success\n")),
        stderr: Stream.make(
          new TextEncoder().encode(
            "\u001b[31m[E] [client] connect to server error: refused\u001b[0m\n",
          ),
        ),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const layer = ManagedTunnel.layer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );
  return { children, commands, layer };
});

const run = <A, E>(
  body: (input: Effect.Success<typeof harness>) => Effect.Effect<A, E, ManagedTunnel.ManagedTunnel>,
) =>
  Effect.gen(function* () {
    const input = yield* harness;
    return yield* body(input).pipe(Effect.provide(input.layer));
  }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, { SHELL: "/bin/zsh" }),
  );

describe("ManagedTunnel", () => {
  it.effect("runs the command in a login shell and restarts it with backoff", () =>
    run(({ children, commands }) =>
      Effect.gen(function* () {
        const tunnel = yield* ManagedTunnel.ManagedTunnel;
        yield* tunnel.configure({ command: "frpc -c ~/frpc.toml", enabled: true });
        const first = yield* Queue.take(children);
        assert.deepEqual(yield* Ref.get(commands), [["/bin/zsh", "-lc", "frpc -c ~/frpc.toml"]]);

        const backingOff = yield* tunnel.changes.pipe(
          Stream.filter((state) => state.status === "backing-off"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(first.exit, ChildProcessSpawner.ExitCode(1));
        yield* Deferred.await(first.killed);
        // Output is read while the child runs; the exit keeps the last error line it printed.
        const exited = Option.getOrThrow(yield* Fiber.join(backingOff));
        assert.strictEqual(exited.status, "backing-off");
        assert.include(exited.lastError ?? "", "connect to server error");
        assert.notInclude(exited.recentOutput.join("\n"), "\u001b");

        // No respawn before the first backoff step ends.
        yield* TestClock.adjust(Duration.millis(999));
        assert.strictEqual(yield* Queue.size(children), 0);
        yield* TestClock.adjust(Duration.millis(1));
        const second = yield* Queue.take(children);

        assert.strictEqual((yield* tunnel.state).restarts, 1);

        yield* tunnel.configure({ command: "frpc -c ~/frpc.toml", enabled: false });
        yield* Deferred.await(second.killed);
        assert.strictEqual((yield* tunnel.state).status, "stopped");
      }),
    ),
  );

  it("doubles the restart delay while the client keeps crashing", () => {
    assert.strictEqual(ManagedTunnel.restartDelayMs(0, 100), 1_000);
    assert.strictEqual(ManagedTunnel.restartDelayMs(1_000, 100), 2_000);
    assert.strictEqual(ManagedTunnel.restartDelayMs(32_000, 100), 60_000);
    assert.strictEqual(ManagedTunnel.restartDelayMs(60_000, 100), 60_000);
    assert.strictEqual(ManagedTunnel.restartDelayMs(60_000, 30_000), 1_000);
  });
});
