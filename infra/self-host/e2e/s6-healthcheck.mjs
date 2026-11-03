// The registry's event loop is blocked for good (SIGUSR2 hook from the test preload). healthcheck.mjs must get the
// container restarted by itself, and the tunnel must come back without anyone touching it.
import * as NodeChildProcess from "node:child_process";

import {
  DOMAIN,
  Frpc,
  ORIGIN,
  compose,
  enrol,
  frpcConfig,
  get,
  say,
  sleep,
  startOrigin,
} from "./lib.mjs";

const inspect = () => {
  const id = compose("ps", "-q", "registry").stdout.trim();
  const out = NodeChildProcess.spawnSync(
    "docker",
    ["inspect", id, "--format", "{{.RestartCount}}|{{.State.StartedAt}}|{{.State.Health.Status}}"],
    { encoding: "utf8" },
  ).stdout.trim();
  const [restarts, startedAt, health] = out.split("|");
  return { restarts: Number(restarts), startedAt, health };
};

const { server } = await startOrigin(18705, "hc-origin", { closeEachResponse: true });
const device = await enrol("Health", "computer");
const host = `${device.joined.subdomain}.${DOMAIN}`;
const tunnel = new Frpc("health", (logPath) =>
  frpcConfig({
    device,
    ticket: device.ticket(),
    subdomain: device.joined.subdomain,
    localPort: 18705,
    logPath,
  }),
);
await tunnel.waitFor(/start proxy success/);
say(`tunnel up, GET -> ${(await get(host)).status}; registry ${JSON.stringify(inspect())}`);

const before = inspect();
const t0 = Date.now();
const kill = compose("exec", "-T", "registry", "sh", "-c", "kill -USR2 $(cat /tmp/server.pid)");
say(`blocked the registry's event loop (kill -USR2): exit=${kill.status}`);
let last = "";
let restarted = null;
while (Date.now() - t0 < 120_000) {
  const now = inspect();
  const summary = `restarts=${now.restarts} health=${now.health}`;
  if (summary !== last) {
    say(`+${((Date.now() - t0) / 1000).toFixed(1)} s ${summary}`);
    last = summary;
  }
  if (now.restarts > before.restarts) {
    restarted = Date.now() - t0;
    break;
  }
  await sleep(1000);
}
say(
  `container restarted by itself: ${restarted === null ? "NO (gave up after 120 s)" : `yes, ${(restarted / 1000).toFixed(1)} s after the loop was blocked`}`,
);
const info = await fetch(`${ORIGIN}/v1/info`)
  .then((r) => r.status)
  .catch((e) => `error ${e.cause?.code ?? e.message}`);
say(`GET /v1/info right after the restart -> ${info}`);
for (let i = 0; i < 60 && inspect().health !== "healthy"; i += 1) await sleep(1000);
say(`registry after the restart: ${JSON.stringify(inspect())}`);
const dropped = /error|reconnect|login to server success/i;
const lines = tunnel.log().split("\n");
const logins = lines.filter((l) => /login to server success/.test(l)).length;
say(
  `frpc logins: ${logins} (1 = the connection never dropped; the restart was shorter than the 30 s heartbeat)`,
);
say(`GET through the tunnel after the restart -> ${(await get(host)).status}`);
say(
  `frpc log lines that mention an error: ${lines.filter((l) => dropped.test(l) && !/login to server success/.test(l)).length}`,
);
await tunnel.stop();
server.close();
