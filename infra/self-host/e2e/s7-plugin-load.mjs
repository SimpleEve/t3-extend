// Plugin latency while the public API is saturated. The design moves the plugin into a worker_thread when p99 > 100 ms.
// The load generator runs inside the registry container (same CPU quota as the registry: the harshest case).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ORIGIN, compose, enrol, say } from "./lib.mjs";

const SCRIPT = NodeFS.readFileSync(
  NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "load-in-container.mjs"),
  "utf8",
);
const device = await enrol("Load", "computer");
const user = device.id.slice(0, 16);

const baseline = compose(
  "exec",
  "-T",
  "-e",
  `S=${SCRIPT}`,
  "-e",
  `CFG=${JSON.stringify({ origin: ORIGIN, user, ticket: device.ticket(), seconds: 5, concurrency: 1 })}`,
  "-e",
  "MODE=probe",
  "registry",
  "sh",
  "-c",
  'node --input-type=module -e "$S"',
);
say(`baseline (idle API):\n${baseline.stdout}${baseline.stderr}`);

const loaded = compose(
  "exec",
  "-T",
  "-e",
  `S=${SCRIPT}`,
  "-e",
  `CFG=${JSON.stringify({ origin: ORIGIN, user, ticket: device.ticket(), seconds: 20, concurrency: 64 })}`,
  "registry",
  "sh",
  "-c",
  'MODE=api node --input-type=module -e "$S" & MODE=api node --input-type=module -e "$S" & MODE=probe node --input-type=module -e "$S"; wait',
);
say(
  `saturated public API (2 x 64 concurrent signed requests, each from its own client IP):\n${loaded.stdout}${loaded.stderr}`,
);
const after = compose(
  "exec",
  "-T",
  "registry",
  "node",
  "-e",
  'fetch("http://127.0.0.1:8080/v1/info").then(r=>console.log("registry still answers /v1/info:", r.status))',
);
say(after.stdout.trim() + after.stderr.trim());
