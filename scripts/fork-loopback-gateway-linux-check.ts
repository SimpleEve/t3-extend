// @effect-diagnostics nodeBuiltinImport:off globalDate:off - an end-to-end driver around Docker and a pipe of tracked files.
// T3 Extend: `vp run fork:loopback-gateway:linux-check`. Runs the loopback gateway's real-process
// tests (the port check, the process inspector's `/proc` reads, the exclusion rules) inside a Linux
// container, as the container's unprivileged user. Nothing here changes what the server advertises.
//
//   node scripts/fork-loopback-gateway-linux-check.ts [--image node:24-bookworm] [--registry <url>] [--drop-store]
//
// The tracked files of this checkout (working tree content, so uncommitted edits count; `.repos` and
// `apps/mobile` left out) are piped into a container's own `/work`; this checkout's `node_modules` is
// never mounted or touched. Linux dependencies go into `/work` through a named volume that caches the
// pnpm store between runs (`t3x-linux-check-store`; `--drop-store` removes it at the end). No port is
// published and no compose project is created. The container is removed at the end, on failure and on
// Ctrl-C too, and the removal is checked: if the container is still there, the run fails and says
// how to remove it. The volume's name is fixed, so two runs at the same time share its pnpm store.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const STORE_VOLUME = "t3x-linux-check-store";
const PNPM = "12.14.0";

/** The real-process tests and the exclusion tests; the rest of the folder tests the route on any platform. */
const TEST_FILES = [
  "ProcessInspector.test.ts",
  "PortAuthorizer.test.ts",
  "PortAuthorizerBatch.test.ts",
  "GatewayExclusions.test.ts",
  "ExclusionsInventory.test.ts",
  "RuntimeSignatures.test.ts",
  "TerminalShellRegistry.test.ts",
].map((file) => `src/fork/loopbackGateway/${file}`);

const { values: flags } = NodeUtil.parseArgs({
  options: {
    image: { type: "string", default: "node:24-bookworm" },
    registry: { type: "string" },
    "drop-store": { type: "boolean", default: false },
  },
});

const say = (message: string): void => {
  process.stdout.write(`${new Date().toISOString().slice(11, 23)} ${message}\n`);
};

const run = (
  args: ReadonlyArray<string>,
  options: { readonly input?: NodeChildProcess.ChildProcess["stdout"] | undefined } = {},
): Promise<number> =>
  new Promise((resolve) => {
    const child = NodeChildProcess.spawn("docker", [...args], {
      stdio: [options.input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
    options.input?.pipe(child.stdin!);
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });

const capture = (command: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(command, [...args], { encoding: "utf8" }, (error, stdout) =>
      error === null ? resolve(stdout.trim()) : reject(error),
    );
  });

const container = `t3x-linux-check-${NodeCrypto.randomBytes(4).toString("hex")}`;
let attempted = false;
let cleaning: Promise<string | undefined> | undefined;

const exists = (kind: "container" | "volume", name: string): Promise<boolean> =>
  capture("docker", [kind, "inspect", name]).then(
    () => true,
    () => false,
  );

/** Removes what this run created and checks it is gone; resolves to what is left, if anything. */
const cleanup = (): Promise<string | undefined> => {
  cleaning ??= (async () => {
    const left: Array<string> = [];
    if (attempted) {
      const removed = await run(["rm", "-f", container]);
      if (removed !== 0 || (await exists("container", container))) {
        left.push(`container ${container}: remove it with \`docker rm -f ${container}\``);
      }
    }
    if (flags["drop-store"]) {
      const removed = await run(["volume", "rm", "-f", STORE_VOLUME]);
      if (removed !== 0 || (await exists("volume", STORE_VOLUME))) {
        left.push(`volume ${STORE_VOLUME}: remove it with \`docker volume rm -f ${STORE_VOLUME}\``);
      }
    }
    return left.length === 0 ? undefined : left.join("\n");
  })();
  return cleaning;
};
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => void cleanup().finally(() => process.exit(code)));
}

const exec = (user: string, script: string, input?: NodeChildProcess.ChildProcess["stdout"]) =>
  run(
    ["exec", ...(input === undefined ? [] : ["-i"]), "-u", user, container, "sh", "-ec", script],
    { input },
  );

let code = 1;
try {
  const registry = flags.registry ?? (await capture("npm", ["config", "get", "registry"]));
  say(`Starting ${container} from ${flags.image} (registry ${registry})`);
  if ((await run(["volume", "create", STORE_VOLUME])) !== 0)
    throw new Error("docker volume create failed");
  attempted = true;
  if (
    (await run([
      "run",
      "-d",
      "--name",
      container,
      "--init",
      "-v",
      `${STORE_VOLUME}:/store`,
      flags.image!,
      "sleep",
      "infinity",
    ])) !== 0
  ) {
    throw new Error("docker run failed");
  }

  // lsof is what the port check's own self-check test lists listeners with; pnpm is the repo's.
  say("Installing lsof and pnpm in the container");
  await exec(
    "root",
    `mkdir /work && chown node:node /work && chown -R node:node /store
     apt-get update -qq && apt-get install -y -qq --no-install-recommends lsof
     npm i -g pnpm@${PNPM} --registry=${registry} --no-fund --no-audit --loglevel=error`,
  ).then((status) => {
    if (status !== 0) throw new Error("container setup failed");
  });

  say("Copying the tracked files");
  const tracked = NodeChildProcess.spawn(
    "git",
    ["ls-files", "-z", "--", ".", ":!.repos", ":!apps/mobile"],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  const packed = NodeChildProcess.spawn("tar", ["--null", "-T", "-", "--no-xattrs", "-cf", "-"], {
    cwd: REPO_ROOT,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  tracked.stdout.pipe(packed.stdin);
  const copied = await exec("node", "tar -C /work -xf -", packed.stdout);
  if (copied !== 0) throw new Error("copying the tracked files failed");

  say("Installing the server's dependencies for Linux (no install scripts)");
  const installed = await exec(
    "node",
    // The server package is named `t3`; the root holds vite-plus, which runs the tests.
    `cd /work && pnpm config set store-dir /store
     pnpm install --frozen-lockfile --ignore-scripts --filter "t3..." --filter . --registry=${registry}`,
  );
  if (installed !== 0) throw new Error("pnpm install failed in the container");

  say(`Running ${TEST_FILES.length} test files as the container's user`);
  code = await exec(
    "node",
    `cd /work && echo "$(id -un) uid=$(id -u) $(uname -sr) $(uname -m) node $(node -v)"
     cd apps/server && ../../node_modules/.bin/vp test run ${TEST_FILES.join(" ")}`,
  );
  say(code === 0 ? "PASSED on Linux." : `FAILED on Linux (exit ${code}).`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  code = 1;
}
const left = await cleanup();
if (left !== undefined) {
  process.stderr.write(
    `CLEANUP FAILED, so this run is reported as failed. Left behind:\n${left}\n`,
  );
  code = 1;
}
process.exit(code);
