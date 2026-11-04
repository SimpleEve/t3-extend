// fork: real-Electron smoke for the loopback gateway. Not part of CI; it signals only the Electron
// PID it started, keeps its user data under /tmp, and exits non-zero if any path fails.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(here, "../..");
const require = NodeModule.createRequire(NodePath.join(desktopDir, "package.json"));
const TIMEOUT_MS = 180_000;

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script without an Effect runtime.
if (NodeOS.platform() !== "darwin") {
  console.error("The smoke is only set up for macOS (--use-mock-keychain, hidden windows).");
  process.exit(2);
}

// Make sure the Electron binary is unpacked; this uses the local download cache.
NodeChildProcess.execFileSync(
  process.execPath,
  [NodePath.join(desktopDir, "scripts/ensure-electron-runtime.mjs")],
  {
    stdio: "inherit",
  },
);
const electronBinary = require("electron");

const outputDir = NodePath.join("/tmp/t3x-p92", `smoke-${Date.now()}`);
NodeFS.mkdirSync(outputDir, { recursive: true });

// The host app injects these; either one would turn Electron into a Node REPL or point at the
// official CLI.
const env = { ...process.env, T3X_SMOKE_OUTPUT: outputDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.T3CODE_CLI_PATH;

const child = NodeChildProcess.spawn(
  electronBinary,
  [
    NodePath.join(here, "main.mjs"),
    `--user-data-dir=${NodePath.join(outputDir, "user-data")}`,
    "--use-mock-keychain",
    "--host-resolver-rules=MAP direct.test 127.0.0.1",
    "--disable-features=CalculateNativeWinOcclusion",
  ],
  { cwd: desktopDir, env, stdio: ["ignore", "pipe", "pipe"] },
);
const electronPid = child.pid;
console.log(`electron pid ${electronPid}, output in ${outputDir}`);
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) =>
  NodeFS.appendFileSync(NodePath.join(outputDir, "stderr.log"), chunk),
);

const deadline = setTimeout(() => {
  console.error(`Timed out after ${TIMEOUT_MS / 1000} s; stopping electron pid ${electronPid}.`);
  child.kill("SIGTERM");
}, TIMEOUT_MS);

child.once("exit", (code, signal) => {
  clearTimeout(deadline);
  const resultsFile = NodePath.join(outputDir, "results.json");
  const results = NodeFS.existsSync(resultsFile)
    ? JSON.parse(NodeFS.readFileSync(resultsFile, "utf8"))
    : [];
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} paths passed`);
  for (const result of failed) console.log(`FAILED ${result.name}: ${result.detail}`);
  let leftover = false;
  try {
    process.kill(electronPid, 0);
    leftover = true;
  } catch {
    leftover = false;
  }
  console.log(`electron exited (code ${code}, signal ${signal}); still running: ${leftover}`);
  process.exit(results.length > 0 && failed.length === 0 && code === 0 && !leftover ? 0 : 1);
});
