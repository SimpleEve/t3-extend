// A stand-in for frpc: a Node script written to a temp directory with a shebang. It answers
// `-v`, and when started with `-c <file>` records its argv, environment and the config it was
// given, then prints the lines the test scripted for that run and stays alive until killed.
// @effect-diagnostics nodeBuiltinImport:off -- The fake is a real executable file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

export type FakeFrpcStep =
  | { readonly line: string }
  /** Raw bytes, hex-encoded: for output that is not valid UTF-8. */
  | { readonly hex: string }
  | { readonly exit: number };

export interface FakeFrpcControl {
  readonly version: string;
  /** One script per run, counted from 0; the last one repeats. */
  readonly scripts: ReadonlyArray<ReadonlyArray<FakeFrpcStep>>;
}

export interface FakeFrpcRecord {
  readonly run: number;
  readonly pid: number;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly config: string;
  readonly configMode: number;
  readonly configDirMode: number;
}

const SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const control = JSON.parse(fs.readFileSync(path.join(dir, "control.json"), "utf8"));
const args = process.argv.slice(2);
if (args[0] === "-v") {
  process.stdout.write(control.version + "\\n");
  process.exit(0);
}
const countFile = path.join(dir, "runs.count");
let run = 0;
try { run = Number(fs.readFileSync(countFile, "utf8")); } catch {}
fs.writeFileSync(countFile, String(run + 1));
const configPath = args[args.indexOf("-c") + 1];
fs.appendFileSync(path.join(dir, "record.jsonl"), JSON.stringify({
  run,
  pid: process.pid,
  argv: args,
  env: process.env,
  config: fs.readFileSync(configPath, "utf8"),
  configMode: fs.statSync(configPath).mode & 0o777,
  configDirMode: fs.statSync(path.dirname(configPath)).mode & 0o777,
}) + "\\n");
if (control.pidLog) fs.appendFileSync(control.pidLog, "fake-frpc " + process.pid + "\\n");
const script = control.scripts[Math.min(run, control.scripts.length - 1)] ?? [];
for (const step of script) {
  if ("line" in step) fs.writeSync(1, step.line + "\\n");
  else if ("hex" in step) fs.writeSync(1, Buffer.from(step.hex, "hex"));
  else if ("exit" in step) process.exit(step.exit);
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

export interface FakeFrpc {
  readonly path: string;
  readonly dir: string;
  readonly setControl: (control: FakeFrpcControl) => void;
  readonly records: () => ReadonlyArray<FakeFrpcRecord>;
}

/** The fake lives in a fresh temp directory that the returned effect's scope removes. */
export const makeFakeFrpc = (initial: FakeFrpcControl) =>
  Effect.acquireRelease(
    Effect.sync((): FakeFrpc => {
      const dir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-fakefrpc-")),
      );
      const path = NodePath.join(dir, "frpc");
      NodeFS.writeFileSync(path, `#!${process.execPath}\n${SOURCE}`, { mode: 0o755 });
      const setControl = (control: FakeFrpcControl) =>
        NodeFS.writeFileSync(
          NodePath.join(dir, "control.json"),
          // The fake's own environment is whatever DeviceTunnel passes, so a pid log is named here.
          JSON.stringify({ ...control, pidLog: process.env.T3X_TEST_PID_LOG }),
        );
      setControl(initial);
      return {
        path,
        dir,
        setControl,
        records: () => {
          try {
            return NodeFS.readFileSync(NodePath.join(dir, "record.jsonl"), "utf8")
              .split("\n")
              .filter((line) => line !== "")
              .map((line) => JSON.parse(line) as FakeFrpcRecord);
          } catch {
            return [];
          }
        },
      };
    }),
    (fake) => Effect.sync(() => NodeFS.rmSync(fake.dir, { recursive: true, force: true })),
  );
