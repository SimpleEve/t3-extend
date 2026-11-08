// frpc must not outlive the server (8a): not when the server stops it, and not when the server is
// killed outright. The fake frpc holds a FIFO open for writing, so its death is the reader's EOF.
// @effect-diagnostics nodeBuiltinImport:off -- Real subprocesses stand in for the server and for frpc.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { frpcCommand } from "./frpcProcess.ts";

const PLATFORM = HostProcess.Platform.defaultValue();
const SERVER_DIR = NodePath.resolve(import.meta.dirname, "../../..");

/** A directory, a FIFO in it, and a fake frpc that announces its pid on the FIFO and then idles. */
const arrange = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-frpcproc-")),
    );
    const fifo = NodePath.join(dir, "pipe");
    NodeChildProcess.execFileSync("mkfifo", [fifo]);
    const fake = NodePath.join(dir, "frpc");
    NodeFS.writeFileSync(
      fake,
      `#!${process.execPath}\nconst fs = require("node:fs");\nconst fd = fs.openSync(process.argv[3], "w");\nfs.writeSync(fd, process.pid + "\\n");\nsetInterval(() => {}, 1 << 30);\n`,
      { mode: 0o755 },
    );
    return { dir, fifo, fake };
  }),
  ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

/** Reads the fake's pid, then resolves when the fake has closed the FIFO, which only its death does. */
const watchFifo = (fifo: string) =>
  new Promise<{ readonly pid: number; readonly closed: Promise<void> }>((resolve) => {
    const lines = NodeReadline.createInterface({ input: NodeFS.createReadStream(fifo) });
    const closed = new Promise<void>((done) => lines.once("close", () => done()));
    lines.once("line", (line) => resolve({ pid: Number(line), closed }));
  });

const isGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe.skipIf(PLATFORM === "win32")("frpcCommand", () => {
  it.live("a normal stop ends frpc, and the stop returns without waiting out the grace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fifo, fake } = yield* arrange;
        const watching = watchFifo(fifo);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            yield* spawner.spawn(
              frpcCommand({
                platform: PLATFORM,
                executable: fake,
                configFile: fifo,
                // @effect-diagnostics-next-line processEnvInEffect:off - fork: the fake frpc needs the host PATH to find `sh`; a test fixture.
                env: { PATH: process.env.PATH ?? "" },
                killGrace: "30 seconds",
              }),
            );
            yield* Effect.promise(() => watching);
          }),
        );
        const { closed } = yield* Effect.promise(() => watching);
        yield* Effect.promise(() => closed);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("frpc dies when the server is killed with SIGKILL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fifo, fake } = yield* arrange;
        const watching = watchFifo(fifo);
        const program = `
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { frpcCommand } from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "frpcProcess.ts")).href)};
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* spawner.spawn(frpcCommand({ platform: ${JSON.stringify(PLATFORM)}, executable: ${JSON.stringify(fake)}, configFile: ${JSON.stringify(fifo)}, env: { PATH: process.env.PATH ?? "" }, killGrace: "30 seconds" }));
      yield* Effect.never;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
`;
        const server = NodeChildProcess.spawn(
          process.execPath,
          ["--input-type=module", "-e", program],
          { cwd: SERVER_DIR, stdio: "ignore" },
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => void server.kill("SIGKILL")));
        const { pid, closed } = yield* Effect.promise(() => watching);
        assert.isFalse(isGone(pid));
        server.kill("SIGKILL");
        yield* Effect.promise(() => closed);
      }),
    ),
  );
});
