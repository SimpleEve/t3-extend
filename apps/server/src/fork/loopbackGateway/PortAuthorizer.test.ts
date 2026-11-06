// The per-tunnel check against real processes (macOS): the test process is "the server", its
// children are terminals, providers and jobs. The inspector is the real one, wrapped so a test can
// count its reads or change what it returns between steps.
// @effect-diagnostics nodeBuiltinImport:off -- Real subprocesses and loopback sockets.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { LOOPBACK_GATEWAY_BLOCKED_PORTS } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  ConfiguredExecutables,
  RESCAN_MIN_INTERVAL_MS,
  chooseDialHost,
  make as makeAuthorizer,
  type GatewayRefusal,
} from "./PortAuthorizer.ts";
import * as ProcessInspector from "./ProcessInspector.ts";
import { TestProcesses } from "./processFixtures.testkit.ts";
import * as TerminalShellRegistry from "./TerminalShellRegistry.ts";

type Snapshot = ReadonlyArray<{ readonly port: number; readonly pid: number | null }>;

type InspectEffect<A> = Effect.Effect<A, ProcessInspector.ProcessInspectError>;

interface Overrides {
  startTime?: (pid: number, real: InspectEffect<string | null>) => InspectEffect<string | null>;
  table?: InspectEffect<ProcessInspector.ProcessTable>;
  launchText?: InspectEffect<string | null>;
  listeners?: InspectEffect<ReadonlyArray<ReadonlyArray<ProcessInspector.ListenerEntry>>>;
}

const rigLayer = Layer.mergeAll(ProcessInspector.layerDarwin, TestProcesses.layer).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeRig = Effect.gen(function* () {
  const real = yield* ProcessInspector.ProcessInspector;
  const scans = { background: 0, forced: 0 };
  const reads = { table: 0, startTime: 0, listeners: 0, listenersOf: 0, launchText: 0 };
  const override: Overrides = {};
  const rig = { snapshot: [] as Snapshot, shells: new Map<number, { startTime: string | null }>() };
  const counted = ProcessInspector.ProcessInspector.of({
    table: Effect.suspend(() => {
      reads.table += 1;
      return override.table ?? real.table;
    }),
    startTime: (pid) => {
      reads.startTime += 1;
      const read = real.startTime(pid);
      return override.startTime === undefined ? read : override.startTime(pid, read);
    },
    listeners: (ports) => {
      reads.listeners += 1;
      return override.listeners ?? real.listeners(ports);
    },
    listenersOf: (pairs) => {
      reads.listenersOf += 1;
      return real.listenersOf(pairs);
    },
    launchText: (pid) => {
      reads.launchText += 1;
      return override.launchText ?? real.launchText(pid);
    },
  });
  const discovery = PortScanner.PortDiscovery.of({
    scan: () =>
      Effect.sync(() => {
        scans.forced += 1;
        return rig.snapshot as never;
      }),
    scanBackground: () =>
      Effect.sync(() => {
        scans.background += 1;
        return rig.snapshot as never;
      }),
  } as never);
  const authorizer = yield* makeAuthorizer({
    serverPid: process.pid,
    reservedPorts: Effect.succeed(new Set([1234])),
  }).pipe(
    Effect.provideService(ProcessInspector.ProcessInspector, counted),
    Effect.provideService(PortScanner.PortDiscovery, discovery),
    Effect.provideService(TerminalShellRegistry.TerminalShellRegistry, {
      shells: Effect.sync(() => rig.shells),
    }),
    Effect.provideService(ConfiguredExecutables, { read: Effect.succeed([]) }),
  );
  /** Registers `pid` as a running terminal shell, with its real start time. */
  const registerShell = (pid: number) =>
    real.startTime(pid).pipe(Effect.map((startTime) => void rig.shells.set(pid, { startTime })));
  const nominate = (pid: number, port: number) => {
    rig.snapshot = [{ port, pid }];
  };
  return { rig, scans, reads, override, authorizer, registerShell, nominate, real };
});

const code = (effect: Effect.Effect<unknown, GatewayRefusal>) =>
  effect.pipe(
    Effect.map(() => "allowed"),
    Effect.catch((error) => Effect.succeed(error.code)),
  );

describe.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "authorizing a port against real processes",
  () => {
    it.live("allows what runs under a terminal shell, at the address it listens on", () =>
      Effect.gen(function* () {
        const x = yield* makeRig;
        const processes = yield* TestProcesses;
        for (const [host, expected] of [
          ["127.0.0.1", "127.0.0.1"],
          ["::1", "::1"],
          ["*", "127.0.0.1"],
        ] as const) {
          const shell = yield* processes.shell(
            `${process.execPath} ${processes.listenScript} '${host}' 0 0 & wait`,
          );
          yield* x.registerShell(shell.pid);
          const port = Number(shell.info.port);
          x.nominate(Number(shell.info.pid), port);
          const target = yield* x.authorizer.authorize(port);
          assert.deepEqual(target, { host: expected, port, pid: Number(shell.info.pid) });
        }
      }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live("allows a shell that exec'd into the listener", () =>
      Effect.gen(function* () {
        const x = yield* makeRig;
        const processes = yield* TestProcesses;
        const shell = yield* processes.shell(
          `exec ${process.execPath} ${processes.listenScript} 127.0.0.1 0 0`,
        );
        yield* x.registerShell(shell.pid);
        x.nominate(shell.pid, Number(shell.info.port));
        assert.equal((yield* x.authorizer.authorize(Number(shell.info.port))).pid, shell.pid);
      }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "refuses direct children of the server that are not terminal shells, and what they start (E2)",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const direct = yield* processes.listen("127.0.0.1");
          x.nominate(direct.pid, direct.port);
          assert.equal(yield* code(x.authorizer.authorize(direct.port)), "reserved");
          // The same shape under an unregistered shell: only a registered shell makes a terminal.
          const shell = yield* processes.shell(
            `${process.execPath} ${processes.listenScript} 127.0.0.1 0 0 & wait`,
          );
          x.nominate(Number(shell.info.pid), Number(shell.info.port));
          assert.equal(yield* code(x.authorizer.authorize(Number(shell.info.port))), "reserved");
          // And a registered pid whose start time is not the one it was registered with.
          x.rig.shells.set(shell.pid, { startTime: "some other process" });
          assert.equal(yield* code(x.authorizer.authorize(Number(shell.info.port))), "reserved");
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live("refuses a reserved port and the eight blocked ones without reading any process", () =>
      Effect.gen(function* () {
        const x = yield* makeRig;
        assert.equal(yield* code(x.authorizer.authorize(1234)), "reserved");
        for (const port of LOOPBACK_GATEWAY_BLOCKED_PORTS) {
          x.nominate(process.pid, port);
          assert.equal(yield* code(x.authorizer.authorize(port)), "reserved", String(port));
        }
        assert.deepEqual(x.reads, {
          table: 0,
          startTime: 0,
          listeners: 0,
          listenersOf: 0,
          launchText: 0,
        });
      }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "tells a port nothing listens on from one a process outside T3 holds, and refuses both",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const freePort = yield* Effect.promise(
            () =>
              new Promise<number>((resolve) => {
                const server = NodeNet.createServer();
                server.listen(0, "127.0.0.1", () => {
                  const { port } = server.address() as NodeNet.AddressInfo;
                  server.close(() => resolve(port));
                });
              }),
          );
          assert.equal(yield* code(x.authorizer.authorize(freePort)), "upstream-refused");
          // Nothing nominates the port: a process that no terminal or agent started holds it.
          const outsider = yield* processes.listen("127.0.0.1");
          assert.equal(yield* code(x.authorizer.authorize(outsider.port)), "not-owned");
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live("keeps not-owned for an unowned port when the listeners cannot be read", () =>
      Effect.gen(function* () {
        const x = yield* makeRig;
        x.override.listeners = Effect.fail(
          new ProcessInspector.ProcessInspectError({ reason: "lsof failed" }),
        );
        assert.equal(yield* code(x.authorizer.authorize(45000)), "not-owned");
      }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live("refuses at once when the owner exited and another process took the port", () =>
      Effect.gen(function* () {
        const x = yield* makeRig;
        const processes = yield* TestProcesses;
        const shell = yield* processes.shell(
          `${process.execPath} ${processes.listenScript} 127.0.0.1 0 0 & wait`,
        );
        yield* x.registerShell(shell.pid);
        const port = Number(shell.info.port);
        const owner = Number(shell.info.pid);
        x.nominate(owner, port);
        assert.equal(yield* code(x.authorizer.authorize(port)), "allowed");
        // The owner dies; an unrelated process binds the same port; the snapshot still says "owner".
        yield* processes.stop({ pid: owner });
        const thief = yield* processes.listen("127.0.0.1", { port });
        assert.equal(thief.port, port);
        assert.equal(yield* code(x.authorizer.authorize(port)), "owner-changed");
      }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "refuses when the start time differs between the first and the last read, and when a read fails",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const shell = yield* processes.shell(
            `${process.execPath} ${processes.listenScript} 127.0.0.1 0 0 & wait`,
          );
          yield* x.registerShell(shell.pid);
          const port = Number(shell.info.port);
          x.nominate(Number(shell.info.pid), port);
          assert.equal(yield* code(x.authorizer.authorize(port)), "allowed");
          x.override.startTime = () => Effect.succeed("a different instance");
          assert.equal(yield* code(x.authorizer.authorize(port)), "owner-changed");
          x.override.startTime = (_pid, _real) =>
            Effect.fail(new ProcessInspector.ProcessInspectError({ reason: "ps failed" }));
          assert.equal(yield* code(x.authorizer.authorize(port)), "owner-changed");
          delete x.override.startTime;
          x.override.table = Effect.fail(
            new ProcessInspector.ProcessInspectError({ reason: "ps failed" }),
          );
          assert.equal(yield* code(x.authorizer.authorize(port)), "owner-changed");
          delete x.override.table;
          x.override.launchText = Effect.succeed(null);
          assert.equal(yield* code(x.authorizer.authorize(port)), "owner-changed");
          delete x.override.launchText;
          assert.equal(yield* code(x.authorizer.authorize(port)), "allowed");
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live("refuses when two processes listen on the port (SO_REUSEPORT)", () =>
      Effect.gen(function* () {
        const x = yield* makeRig;
        const processes = yield* TestProcesses;
        const first = yield* processes.listen("127.0.0.1", { reusePort: true });
        yield* processes.listen("127.0.0.1", { reusePort: true, port: first.port });
        x.nominate(first.pid, first.port);
        assert.equal(yield* code(x.authorizer.authorize(first.port)), "owner-changed");
      }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "keeps nothing between batches: six tunnels one after another are six full sets of reads",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const shell = yield* processes.shell(
            `${process.execPath} ${processes.listenScript} 127.0.0.1 0 0 & wait`,
          );
          yield* x.registerShell(shell.pid);
          const port = Number(shell.info.port);
          x.nominate(Number(shell.info.pid), port);
          for (let i = 0; i < 6; i++) yield* x.authorizer.authorize(port);
          assert.deepEqual(x.reads, {
            table: 6,
            startTime: 6,
            listeners: 6,
            listenersOf: 6,
            launchText: 6,
          });
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "six tunnels at once to one port are checked from one set of reads, each on its own",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const shell = yield* processes.shell(
            `${process.execPath} ${processes.listenScript} 127.0.0.1 0 0 & wait`,
          );
          yield* x.registerShell(shell.pid);
          const port = Number(shell.info.port);
          x.nominate(Number(shell.info.pid), port);
          const results = yield* Effect.all(
            Array.from({ length: 6 }, () => code(x.authorizer.authorize(port))),
            { concurrency: "unbounded" },
          );
          assert.deepEqual(
            results,
            Array.from({ length: 6 }, () => "allowed"),
          );
          // Against six sets when they come one at a time. Which batch each joined is up to the
          // scheduler; the exact count is pinned in PortAuthorizerBatch.test.ts.
          assert.isBelow(x.reads.table, 6);
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );
  },
);

describe.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "agents and provider runtimes",
  () => {
    const claudeAs = (directory: string) => NodePath.join(directory, "bin", "claude");

    it.live(
      "allows a job under a Claude launcher when it carries the marker, and refuses the launcher's own listener",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const marked = yield* processes.spawnWithJob({
            argv0: claudeAs(processes.directory),
            marker: "thread-a",
          });
          x.nominate(marked.jobPid, marked.jobPort);
          assert.equal((yield* x.authorizer.authorize(marked.jobPort)).pid, marked.jobPid);
          // The marker is cleared: the same job is not an agent's.
          const unmarked = yield* processes.spawnWithJob({ argv0: claudeAs(processes.directory) });
          x.nominate(unmarked.jobPid, unmarked.jobPort);
          assert.equal(yield* code(x.authorizer.authorize(unmarked.jobPort)), "not-owned");
          // The launcher itself, listening (its runtime), is never forwarded.
          const runtime = yield* processes.listen("127.0.0.1", {
            argv0: claudeAs(processes.directory),
            marker: "thread-a",
          });
          x.nominate(runtime.pid, runtime.port);
          assert.equal(yield* code(x.authorizer.authorize(runtime.port)), "reserved");
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "behind a launcher that does not exec: the runtime's listener is refused, its jobs are not, until the launcher dies",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const runtimeScript = processes.scriptPath(
            "codex-darwin-arm64/vendor/codex/codex",
            `
const { spawn } = require("node:child_process");
const net = require("node:net");
const server = net.createServer(() => {}).listen(0, "127.0.0.1", () => {
  const job = spawn(process.execPath, [${JSON.stringify(processes.listenScript)}, "127.0.0.1", "0", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  job.stdout.once("data", (chunk) => {
    const info = JSON.parse(String(chunk));
    console.log(JSON.stringify({ port: server.address().port, pid: process.pid, jobPid: job.pid, jobPort: info.port }));
  });
});
setInterval(() => {}, 1 << 30);
`,
          );
          const launcherScript = processes.scriptPath(
            "node_modules/@openai/codex/bin/codex.js",
            `
const { spawn } = require("node:child_process");
const runtime = spawn(process.execPath, [${JSON.stringify(runtimeScript)}, "app-server"], { stdio: ["ignore", "pipe", "inherit"] });
runtime.stdout.on("data", (chunk) => process.stdout.write(chunk));
setInterval(() => {}, 1 << 30);
`,
          );
          const launcher = yield* processes.listen("127.0.0.1", {
            script: launcherScript,
            args: ["app-server"],
            marker: "thread-codex",
          });
          const runtimePort = Number(launcher.info.port);
          const runtimePid = Number(launcher.info.pid);
          const jobPid = Number(launcher.info.jobPid);
          const jobPort = Number(launcher.info.jobPort);
          x.nominate(runtimePid, runtimePort);
          assert.equal(yield* code(x.authorizer.authorize(runtimePort)), "reserved");
          x.nominate(jobPid, jobPort);
          assert.equal((yield* x.authorizer.authorize(jobPort)).pid, jobPid);
          // The server restarts (the launcher goes): the runtime is adopted by init, and its jobs with it.
          yield* processes.stop(launcher);
          assert.equal(yield* code(x.authorizer.authorize(jobPort)), "reserved");
          x.nominate(runtimePid, runtimePort);
          assert.equal(yield* code(x.authorizer.authorize(runtimePort)), "reserved");
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "refuses a marked job whose launcher is gone: nothing ties an adopted process to this server",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const orphan = yield* processes.spawnWithJob({
            argv0: claudeAs(processes.directory),
            marker: "thread-a",
            mode: "orphan",
          });
          x.nominate(orphan.jobPid, orphan.jobPort);
          assert.equal(yield* code(x.authorizer.authorize(orphan.jobPort)), "not-owned");
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "refuses every listening port of a process started with --inspect, the random one included",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const child = NodeChildProcess.spawn(
            "/bin/sh",
            ["-c", `exec ${process.execPath} --inspect=0 ${processes.listenScript} 127.0.0.1 0 0`],
            { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, T3CODE_THREAD_ID: "" } },
          );
          const ports = yield* Effect.promise(
            () =>
              new Promise<{ service: number; inspector: number }>((resolve) => {
                let service: number | undefined;
                let inspector: number | undefined;
                const done = () =>
                  service !== undefined &&
                  inspector !== undefined &&
                  resolve({ service, inspector });
                child.stdout?.on("data", (chunk: Buffer) => {
                  const line = String(chunk)
                    .split("\n")
                    .find((l) => l.startsWith("{"));
                  if (line !== undefined) service = JSON.parse(line).port;
                  done();
                });
                child.stderr?.on("data", (chunk: Buffer) => {
                  const match = /ws:\/\/127\.0\.0\.1:(\d+)\//u.exec(String(chunk));
                  if (match !== null) inspector = Number(match[1]);
                  done();
                });
              }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => void child.kill("SIGKILL")));
          yield* x.registerShell(child.pid!);
          for (const port of [ports.service, ports.inspector]) {
            x.nominate(child.pid!, port);
            assert.equal(yield* code(x.authorizer.authorize(port)), "debug-process", String(port));
          }
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "refuses the server's own listener and a grandchild of a direct child that is no terminal (hub-shaped)",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const own = yield* Effect.promise(
            () =>
              new Promise<NodeNet.Server>((resolve) => {
                const server = NodeNet.createServer();
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => void own.close()));
          const ownPort = (own.address() as NodeNet.AddressInfo).port;
          x.nominate(process.pid, ownPort);
          assert.equal(yield* code(x.authorizer.authorize(ownPort)), "reserved");
          // A hub starts a daemon that listens: the daemon is the hub's child, not the server's.
          const hub = yield* processes.spawnWithJob({ argv0: "t3-device-hub", mode: "stay" });
          x.nominate(hub.jobPid, hub.jobPort);
          assert.equal(yield* code(x.authorizer.authorize(hub.jobPort)), "reserved");
          // The same job under the hub with the agent marker is still refused: E2 comes first.
          const marked = yield* processes.spawnWithJob({
            argv0: "t3-device-hub",
            marker: "thread-1",
            mode: "stay",
          });
          x.nominate(marked.jobPid, marked.jobPort);
          assert.equal(yield* code(x.authorizer.authorize(marked.jobPort)), "reserved");
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );

    it.live(
      "self-check: every listening port of the server and its descendants is refused, but a terminal's and an agent's jobs",
      () =>
        Effect.gen(function* () {
          const x = yield* makeRig;
          const processes = yield* TestProcesses;
          const marker = "thread-worst-case";
          // In-process listeners: the main port, the tunnel listener, a desktop-tab channel.
          const own = yield* Effect.forEach([0, 1, 2], () =>
            Effect.promise(
              () =>
                new Promise<NodeNet.Server>((resolve) => {
                  const server = NodeNet.createServer();
                  server.listen(0, "127.0.0.1", () => resolve(server));
                }),
            ),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => own.forEach((server) => server.close())),
          );
          // Direct children that are not terminals, every one carrying the agent marker.
          yield* processes.spawnWithJob({ argv0: "t3-device-hub", marker, mode: "stay" });
          yield* processes.listen("127.0.0.1", { argv0: "cloudflared", marker });
          yield* processes.listen("127.0.0.1", { argv0: "frpc", marker });
          yield* processes.listen("127.0.0.1", {
            argv0: NodePath.join(processes.directory, "bin", "opencode"),
            args: ["serve"],
            marker,
          });
          yield* processes.listen("127.0.0.1", {
            argv0: NodePath.join(processes.directory, "bin", "claude"),
            marker,
          });
          // The two things that may be forwarded: a terminal's service and a Claude agent's job.
          const shell = yield* processes.shell(
            `${process.execPath} ${processes.listenScript} 127.0.0.1 0 0 & wait`,
          );
          yield* x.registerShell(shell.pid);
          const agent = yield* processes.spawnWithJob({
            argv0: NodePath.join(processes.directory, "bin", "claude"),
            marker,
          });
          const allowedPorts = new Set([Number(shell.info.port), agent.jobPort]);

          const table = yield* x.real.table;
          const tree = new Set<number>([process.pid]);
          for (let grew = true; grew;) {
            grew = false;
            for (const row of table.values()) {
              if (tree.has(row.ppid) && !tree.has(row.pid)) {
                tree.add(row.pid);
                grew = true;
              }
            }
          }
          const lsof = NodeChildProcess.execFileSync(
            "lsof",
            ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"],
            { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: 1 << 26 },
          );
          const listening: Array<{ pid: number; port: number }> = [];
          let current = 0;
          for (const line of lsof.split("\n")) {
            if (line.startsWith("p")) current = Number(line.slice(1));
            else if (line.startsWith("n") && tree.has(current)) {
              const port = Number(line.slice(line.lastIndexOf(":") + 1));
              if (Number.isInteger(port)) listening.push({ pid: current, port });
            }
          }
          // The in-process ones, three children, the hub's daemon, the shell's job, the agent's job...
          assert.isAtLeast(listening.length, 10);
          for (const { pid, port } of listening) {
            x.nominate(pid, port);
            const outcome = yield* code(x.authorizer.authorize(port));
            if (allowedPorts.has(port)) assert.equal(outcome, "allowed", `port ${port}`);
            else assert.notEqual(outcome, "allowed", `port ${port} of pid ${pid}`);
          }
          assert.deepEqual(
            listening.filter((entry) => allowedPorts.has(entry.port)).length,
            allowedPorts.size,
          );
        }).pipe(Effect.scoped, Effect.provide(rigLayer)),
    );
  },
);

describe("the rescan on a miss", () => {
  it.effect("scans at most once per interval however many tunnels miss", () =>
    Effect.gen(function* () {
      const scans = yield* Ref.make(0);
      const discovery = PortScanner.PortDiscovery.of({
        scan: () => Ref.update(scans, (n) => n + 1).pipe(Effect.as([])),
        scanBackground: () => Effect.succeed([]),
      } as never);
      const authorizer = yield* makeAuthorizer({
        serverPid: process.pid,
        reservedPorts: Effect.succeed(new Set()),
      }).pipe(
        Effect.provideService(PortScanner.PortDiscovery, discovery),
        Effect.provideService(ProcessInspector.ProcessInspector, {
          // Something answers on the port, so every miss is a refusal for the same reason.
          listeners: () => Effect.succeed([[{ pid: 1, address: "*", family: "IPv4" }]]),
        } as never),
        Effect.provideService(TerminalShellRegistry.TerminalShellRegistry, {
          shells: Effect.succeed(new Map()),
        }),
        Effect.provideService(ConfiguredExecutables, { read: Effect.succeed([]) }),
      );
      const miss = () => code(authorizer.authorize(45001));
      assert.equal(yield* miss(), "not-owned");
      assert.equal(yield* miss(), "not-owned");
      assert.equal(yield* Ref.get(scans), 1);
      yield* TestClock.adjust(Duration.millis(RESCAN_MIN_INTERVAL_MS - 1));
      yield* miss();
      assert.equal(yield* Ref.get(scans), 1);
      yield* TestClock.adjust(Duration.millis(1));
      yield* miss();
      assert.equal(yield* Ref.get(scans), 2);
    }),
  );
});

describe("which address to dial", () => {
  it("prefers 127.0.0.1, then ::1, and dials 127.0.0.1 for a wildcard; other addresses are not loopback", () => {
    const entry = (address: string, family: "IPv4" | "IPv6" = "IPv4") => ({
      pid: 1,
      address,
      family,
    });
    assert.equal(chooseDialHost([entry("::1", "IPv6"), entry("127.0.0.1")]), "127.0.0.1");
    assert.equal(chooseDialHost([entry("::1", "IPv6")]), "::1");
    assert.equal(chooseDialHost([entry("*", "IPv6")]), "127.0.0.1");
    assert.equal(chooseDialHost([entry("192.168.1.5")]), null);
    assert.equal(chooseDialHost([]), null);
  });
});
