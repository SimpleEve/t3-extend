// Docker healthcheck. `restart: unless-stopped` only restarts a container that exits; it never restarts one that
// is merely `unhealthy`. So after three consecutive failures (about 30 s at a 10 s interval) this sends SIGTERM
// to PID 1, the container exits, and the restart policy brings it back. Spec: research/self-host-device-keys.md 3.12 D.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

const { readFileSync, writeFileSync } = NodeFS;
const { request } = NodeHttp;

const port = Number(process.env.T3X_PLUGIN_PORT ?? 8081);
const counterFile = process.env.T3X_HEALTH_COUNTER ?? "/tmp/t3x-health-failures";
const FAILURES_BEFORE_RESTART = 3;
const TIMEOUT_MS = 1000;

function probe() {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/health", timeout: TIMEOUT_MS },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

function readCount() {
  try {
    return Number(readFileSync(counterFile, "utf8")) || 0;
  } catch {
    return 0;
  }
}

if (await probe()) {
  writeFileSync(counterFile, "0");
  process.exit(0);
}
const failures = readCount() + 1;
if (failures >= FAILURES_BEFORE_RESTART) {
  writeFileSync(counterFile, "0");
  process.kill(1, "SIGTERM");
} else {
  writeFileSync(counterFile, String(failures));
}
process.exit(1);
