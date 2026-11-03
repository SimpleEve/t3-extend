// fork: how frpc is started (design 3.7, 8a). On macOS and Linux it runs in its own process group with
// a watcher on fd 3, which only the server holds: when the server dies, even by SIGKILL, the watcher
// reads EOF and stops the group (TERM, KILL after 5s). ClaudeAdapterV2's pattern, but the watcher
// ignores TERM only after EOF, so a normal stop's group TERM ends it too and the spawner can return.
import type * as Duration from "effect/Duration";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

const WATCH_SCRIPT = [
  "{ read -r _ <&3; trap '' TERM; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

export const frpcCommand = (input: {
  readonly platform: string;
  readonly executable: string;
  readonly configFile: string;
  readonly env: Record<string, string>;
  /** How long a stopping frpc gets after TERM before it is killed. */
  readonly killGrace: Duration.Input;
}) => {
  const common = {
    env: input.env,
    extendEnv: false,
    shell: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    forceKillAfter: input.killGrace,
  } as const;
  // Windows has no process groups: frpc is a plain child there and can outlive a killed server.
  return input.platform === "win32"
    ? ChildProcess.make(input.executable, ["-c", input.configFile], { ...common, detached: false })
    : ChildProcess.make(
        "/bin/sh",
        ["-c", WATCH_SCRIPT, "t3x-frpc", input.executable, "-c", input.configFile],
        {
          ...common,
          detached: true,
          // Held open and never written to: only its closing, with the server, means anything.
          additionalFds: { fd3: { type: "input", stream: Stream.never } },
        },
      );
};
