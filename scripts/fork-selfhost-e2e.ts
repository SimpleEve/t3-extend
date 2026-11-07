// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - an end-to-end driver around Docker and real processes.
// T3 Extend: `vp run fork:selfhost:e2e`. Brings up the self-host stack locally (registry, frps, Caddy
// with its own CA, published only on loopback), starts this checkout's server as two or three
// "computers" on temporary homes, simulates a phone in Node, and runs research/self-host-device-keys.md 7.2.
//
//   node scripts/fork-selfhost-e2e.ts [--port 18443] [--project t3x-e2e] [--frpc-path <file>] [--keep]
//                                     [--only 1,2,4,15]
//
// The port defaults to 18443 and moves to a free one when that is taken; an explicit --port that is
// taken is an error. Only processes this script started are stopped, and the compose project, its
// volumes and the temporary directory are removed at the end. A failed run keeps the directory
// (logs, homes) and prints where it is; --keep also keeps it, and the compose project, after a pass.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";
import * as NodeUtil from "node:util";

import { resolveFrpc } from "./lib/fork-frpc.ts";
import type { E2eContext } from "./fork-selfhost-e2e/computer.ts";
import { scenarios, type World } from "./fork-selfhost-e2e/scenarios.ts";
import { prepareStack, type Stack } from "./fork-selfhost-e2e/stack.ts";
import {
  E2eFailure,
  freePort,
  portIsFree,
  ProcessRegistry,
  say,
} from "./fork-selfhost-e2e/util.ts";

const DEFAULT_PORT = 18_443;

const { values: flags } = NodeUtil.parseArgs({
  options: {
    port: { type: "string" },
    project: { type: "string", default: "t3x-e2e" },
    "frpc-path": { type: "string" },
    keep: { type: "boolean", default: false },
    only: { type: "string" },
  },
});

async function choosePort(): Promise<number> {
  if (flags.port !== undefined) {
    const requested = Number(flags.port);
    if (!Number.isInteger(requested) || requested < 1024 || requested > 65_535) {
      throw new E2eFailure(`--port ${flags.port} is not a usable port.`);
    }
    if (!(await portIsFree(requested))) {
      throw new E2eFailure(
        `Port ${requested} is already in use on the loopback addresses; pick another with --port.`,
      );
    }
    return requested;
  }
  if (await portIsFree(DEFAULT_PORT)) return DEFAULT_PORT;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = await freePort();
    if (await portIsFree(candidate)) {
      say(`Port ${DEFAULT_PORT} is in use (by something that is not ours); using ${candidate}.`);
      return candidate;
    }
  }
  throw new E2eFailure("No free port found.");
}

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-e2e-"));
const processes = new ProcessRegistry();
let stack: Stack | undefined;
let failed = false;
let cleanupProblem: string | undefined;
let cleaning: Promise<void> | undefined;

// Registered as soon as the stack exists on paper, before anything is started, so a signal, an
// exception or a timeout at any later point still removes the project.
const cleanup = (): Promise<void> => {
  cleaning ??= (async () => {
    await processes.stopAll();
    if (stack !== undefined && !(flags.keep && !failed)) {
      cleanupProblem = await stack.down();
      if (cleanupProblem !== undefined) failed = true;
    }
    // A run that failed before the stack was prepared (a bad flag, no Docker) has no logs worth
    // keeping; a failed `down` keeps everything.
    if ((!failed && !flags.keep) || stack === undefined) {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  })();
  return cleaning;
};

const abort = (code: number) => (): void => {
  failed = true;
  void cleanup().finally(() => process.exit(code));
};
process.once("SIGINT", abort(130));
process.once("SIGTERM", abort(143));
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`Unhandled rejection: ${String(reason)}\n`);
  abort(1)();
});

interface Outcome {
  readonly id: number;
  readonly title: string;
  readonly seconds: number;
  readonly error?: string;
}

const outcomes: Array<Outcome> = [];
const startedAt = Date.now();

try {
  const frpcPath = await resolveFrpc({ explicitPath: flags["frpc-path"], log: say });
  const port = await choosePort();
  stack = await prepareStack({ project: flags.project, port, workDir, say });
  await stack.up();
  // Trust Caddy's internal CA inside this process; child processes get it through NODE_EXTRA_CA_CERTS.
  NodeTls.setDefaultCACertificates([
    ...NodeTls.getCACertificates("default"),
    NodeFS.readFileSync(stack.caFile, "utf8"),
  ]);
  const ctx: E2eContext = { processes, workDir, caFile: stack.caFile, frpcPath };
  const world: World = { ctx, stack, computers: [] };
  say(`Stack is up on https://t3.localhost:${port}; work directory ${workDir}`);

  const only = flags.only?.split(",").map(Number);
  for (const scenario of scenarios.filter((s) => only === undefined || only.includes(s.id))) {
    const began = Date.now();
    say(`--- ${scenario.id}. ${scenario.title}`);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        scenario.run(world),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new E2eFailure(
                  `Scenario ${scenario.id} did not finish in ${scenario.timeoutMs / 1000} s.`,
                ),
              ),
            scenario.timeoutMs,
          );
        }),
      ]);
      const seconds = (Date.now() - began) / 1000;
      outcomes.push({ id: scenario.id, title: scenario.title, seconds });
      say(`PASS ${scenario.id} (${seconds.toFixed(1)} s)`);
    } catch (error) {
      const seconds = (Date.now() - began) / 1000;
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ id: scenario.id, title: scenario.title, seconds, error: message });
      failed = true;
      say(`FAIL ${scenario.id} (${seconds.toFixed(1)} s): ${message}`);
      for (const computer of world.computers) {
        say(
          `--- last lines of ${computer.name}'s server log (${computer.log.file})\n${computer.log.tail(30)}`,
        );
      }
      const logs = await stack.compose(
        "logs",
        "--no-color",
        "--tail",
        "40",
        "registry",
        "frps",
        "caddy",
      );
      NodeFS.writeFileSync(NodePath.join(workDir, "compose.log"), logs.stdout + logs.stderr);
      say(`--- stack logs: ${NodePath.join(workDir, "compose.log")}`);
      break;
    } finally {
      clearTimeout(timer);
    }
  }
} catch (error) {
  failed = true;
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
}

const total = (Date.now() - startedAt) / 1000;
process.stdout.write("\nScenario results\n");
for (const outcome of [...outcomes].toSorted((a, b) => a.id - b.id)) {
  process.stdout.write(
    `  ${outcome.error === undefined ? "PASS" : "FAIL"}  ${String(outcome.id).padStart(2)}  ${outcome.seconds.toFixed(1).padStart(6)} s  ${outcome.title}\n`,
  );
}
process.stdout.write(`  total ${total.toFixed(1)} s\n`);

await cleanup();
if (cleanupProblem !== undefined) {
  process.stdout.write(
    `\nCLEANUP FAILED, so this run is reported as failed.\n${cleanupProblem}\nLogs and homes are in ${workDir}\n`,
  );
} else if (failed) {
  process.stdout.write(
    stack === undefined
      ? "\nFAILED before the stack was up.\n"
      : `\nFAILED. Logs and homes are in ${workDir}\n`,
  );
} else if (flags.keep) {
  process.stdout.write(
    `\nPASSED. Kept ${workDir} and the compose project ${flags.project}; remove the project with \`docker compose -p ${flags.project} down -v\`.\n`,
  );
} else {
  process.stdout.write("\nPASSED.\n");
}
process.exit(failed ? 1 : 0);
