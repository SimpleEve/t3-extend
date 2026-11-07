// Real child processes for the gateway's tests: small node scripts that listen on loopback, spawn
// jobs, or pose as a provider's launcher. Everything is stopped by the pid captured at spawn.
// @effect-diagnostics nodeBuiltinImport:off -- Real subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessInspector from "./ProcessInspector.ts";

/** The platforms with a real inspector (`ps` and `lsof` on macOS, `/proc` on Linux). */
export const runsOnRealProcesses = ["darwin", "linux"].includes(
  HostProcess.Platform.defaultValue(),
);

/**
 * The platform's real inspector. On macOS the tool limit is far above the test timeout: on a loaded
 * machine the product's 5 s must not decide these reads. Linux reads files and has no limit.
 */
export const realInspectorLayer =
  HostProcess.Platform.defaultValue() === "darwin"
    ? ProcessInspector.layerDarwinWithTimeout(Duration.minutes(10))
    : ProcessInspector.layer;

export interface TestProcess {
  readonly pid: number;
  readonly port: number;
  readonly child: NodeChildProcess.ChildProcess;
  /** The line the script printed once it was ready (JSON). */
  readonly info: Record<string, unknown>;
}

// Node does not offer SO_REUSEPORT on macOS, so the shared-port listener is python.
const REUSE_LISTEN = `
import json, socket, sys, time
host, port = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
s.bind((host, port))
s.listen(8)
print(json.dumps({"port": s.getsockname()[1]}), flush=True)
time.sleep(3600)
`;

const LISTEN = `
const net = require("node:net");
const [host, portArg, reuse] = process.argv.slice(2);
const server = net.createServer((socket) => { socket.on("error", () => {}); socket.pipe(socket); });
const options = { port: Number(portArg), reusePort: reuse === "1" };
if (host !== "*") options.host = host;
server.listen(options, () => console.log(JSON.stringify({ port: server.address().port, pid: process.pid })));
setInterval(() => {}, 1 << 30);
`;

// Starts a listener child, optionally detached so its own exit orphans nothing it spawned, and
// reports the child's pid and port. `mode` "orphan" exits right after spawning (job adopted by init).
const PARENT = `
const { spawn } = require("node:child_process");
const [listener, host, mode, ...rest] = process.argv.slice(2);
const job = spawn(process.execPath, [listener, host, "0", "0"], { stdio: ["ignore", "pipe", "inherit"], detached: mode === "orphan" });
let buffer = "";
job.stdout.on("data", (chunk) => {
  buffer += chunk;
  const line = buffer.split("\\n").find((l) => l.startsWith("{"));
  if (line === undefined) return;
  buffer = "";
  const info = JSON.parse(line);
  console.log(JSON.stringify({ job: job.pid, port: info.port, self: process.pid }));
  if (mode === "orphan") { job.unref(); job.stdout.destroy(); process.exit(0); }
});
setInterval(() => {}, 1 << 30);
`;

export class TestProcesses extends Context.Service<
  TestProcesses,
  {
    readonly directory: string;
    readonly listenScript: string;
    /** A child of the test process that listens on `host` (`*` for the wildcard). */
    readonly listen: (
      host: "127.0.0.1" | "::1" | "*",
      options?: {
        readonly marker?: string;
        readonly argv0?: string;
        readonly reusePort?: boolean;
        readonly port?: number;
        readonly args?: ReadonlyArray<string>;
        readonly script?: string;
      },
    ) => Effect.Effect<TestProcess>;
    /**
     * A child that spawns a listening job and reports both pids. `argv0` and `script` let it pose
     * as a provider's launcher; `orphan` makes it exit once the job listens, adopting the job.
     */
    readonly spawnWithJob: (options: {
      readonly argv0?: string;
      readonly marker?: string;
      readonly mode?: "stay" | "orphan";
      readonly script?: string;
      readonly args?: ReadonlyArray<string>;
    }) => Effect.Effect<{
      readonly parent: TestProcess;
      readonly jobPid: number;
      readonly jobPort: number;
    }>;
    /** Runs `command` in a shell that is a direct child, like a terminal's shell. */
    readonly shell: (command: string) => Effect.Effect<{
      readonly pid: number;
      readonly child: NodeChildProcess.ChildProcess;
      readonly info: Record<string, unknown>;
    }>;
    readonly stop: (process: { readonly pid: number }) => Effect.Effect<void>;
    readonly scriptPath: (name: string, body: string) => string;
  }
>()("t3/fork/loopbackGateway/processFixtures.testkit/TestProcesses") {
  static readonly layer = Layer.effect(
    TestProcesses,
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-gw-test-"));
      const pids = new Set<number>();
      const children = new Map<number, NodeChildProcess.ChildProcess>();
      // pid -> start time when captured, so a pid is only ever signalled while it is still ours.
      const identity = new Map<number, string | null>();
      const startOf = (pid: number) => {
        try {
          const out = NodeChildProcess.execFileSync(
            "/bin/ps",
            ["-ww", "-o", "lstart=", "-p", String(pid)],
            { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: "pipe" },
          ).trim();
          return out.length > 0 ? out : null;
        } catch {
          return null;
        }
      };
      const remember = (pid: number) => {
        pids.add(pid);
        if (!identity.has(pid)) identity.set(pid, startOf(pid));
      };
      const write = (name: string, body: string) => {
        const file = NodePath.join(directory, name);
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, body);
        return file;
      };
      const listenScript = write("listen.cjs", LISTEN);
      const reuseScript = write("reuse_listen.py", REUSE_LISTEN);
      const parentScript = write("parent.cjs", PARENT);
      const cleanEnv = (marker: string | undefined) => {
        const { T3CODE_THREAD_ID: _ambient, ...rest } = process.env;
        return marker === undefined ? rest : { ...rest, T3CODE_THREAD_ID: marker };
      };
      const rememberDescendants = (info: Record<string, unknown>) => {
        for (const key of ["pid", "jobPid", "job"]) {
          if (typeof info[key] === "number") remember(info[key]);
        }
        return info;
      };
      const firstJson = (child: NodeChildProcess.ChildProcess) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          let buffer = "";
          child.stdout?.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const line = buffer.split("\n").find((l) => l.startsWith("{"));
            if (line !== undefined)
              resolve(rememberDescendants(JSON.parse(line) as Record<string, unknown>));
          });
          child.once("exit", () => reject(new Error("exited before it was ready")));
        });
      const track = (child: NodeChildProcess.ChildProcess) => {
        remember(child.pid!);
        children.set(child.pid!, child);
        return child.pid!;
      };
      const stopPid = (pid: number) => {
        // Only the process captured at spawn: a recycled pid is somebody else's.
        const started = identity.get(pid);
        if (started === undefined || started === null || startOf(pid) !== started) return;
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      };
      const exited = (child: NodeChildProcess.ChildProcess) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("exit", () => resolve());
        });
      /** Completes once the captured process is gone (or was never ours any more). */
      const gone = Effect.fn("TestProcesses.gone")(function* (pid: number) {
        const started = identity.get(pid);
        for (let left = 400; left > 0; left--) {
          if (started === null || started === undefined || startOf(pid) !== started) return;
          yield* Effect.sleep(Duration.millis(5));
        }
      });
      const spawnListener: TestProcesses["Service"]["listen"] = (host, options) =>
        Effect.promise(async () => {
          const reuse = options?.reusePort === true;
          const child = NodeChildProcess.spawn(
            reuse ? "python3" : process.execPath,
            reuse
              ? ["-I", reuseScript, host, String(options?.port ?? 0)]
              : [
                  options?.script ?? listenScript,
                  ...(options?.script ? [] : [host, String(options?.port ?? 0), "0"]),
                  ...(options?.args ?? []),
                ],
            {
              env: cleanEnv(options?.marker),
              stdio: ["ignore", "pipe", "inherit"],
              ...(options?.argv0 === undefined ? {} : { argv0: options.argv0 }),
            },
          );
          const pid = track(child);
          const info = await firstJson(child);
          return { pid, port: Number(info.port), child, info };
        });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // Parents first, and wait for them: a shell that outlives its job reports it "Killed".
          const parents = [...children.values()];
          const parentExits = parents.map(exited);
          for (const child of parents) stopPid(child.pid!);
          yield* Effect.promise(() => Promise.all(parentExits));
          // Then what they started, confirmed gone by the pid captured when it appeared.
          const rest = [...pids].filter((pid) => !children.has(pid));
          for (const pid of rest) stopPid(pid);
          yield* Effect.forEach(rest, gone, { discard: true });
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
      );
      return TestProcesses.of({
        directory,
        listenScript,
        listen: spawnListener,
        spawnWithJob: (options) =>
          Effect.promise(async () => {
            const child = NodeChildProcess.spawn(
              process.execPath,
              [
                options.script ?? parentScript,
                ...(options.script ? [] : [listenScript, "127.0.0.1", options.mode ?? "stay"]),
                ...(options.args ?? []),
              ],
              {
                env: cleanEnv(options.marker),
                stdio: ["ignore", "pipe", "inherit"],
                ...(options.argv0 === undefined ? {} : { argv0: options.argv0 }),
              },
            );
            const pid = track(child);
            const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
            const info = await firstJson(child);
            remember(Number(info.job));
            // An orphan is only one once its parent has gone and the job belongs to init.
            if (options.mode === "orphan") await exited;
            return {
              parent: { pid, port: Number(info.port), child, info },
              jobPid: Number(info.job),
              jobPort: Number(info.port),
            };
          }),
        shell: (command) =>
          Effect.promise(async () => {
            const child = NodeChildProcess.spawn("/bin/sh", ["-c", command], {
              env: cleanEnv(undefined),
              // The shell reports a job it did not end ("Killed: 9") on stderr; nobody reads that.
              stdio: ["ignore", "pipe", "ignore"],
            });
            const pid = track(child);
            const info = await firstJson(child);
            if (typeof info.pid === "number") remember(info.pid);
            return { pid, child, info };
          }),
        stop: (target) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                const child = children.get(target.pid);
                if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
                  stopPid(target.pid);
                  return resolve();
                }
                child.once("exit", () => resolve());
                stopPid(target.pid);
              }),
          ),
        scriptPath: write,
      });
    }),
  );
}
