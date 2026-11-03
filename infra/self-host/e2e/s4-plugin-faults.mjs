// Slow plugin (Login sleeps past the 1.5 s limit) and registry outage/restart, with a real frpc.
import {
  DOMAIN,
  Frpc,
  compose,
  enrol,
  frpcConfig,
  get,
  ORIGIN,
  say,
  sleep,
  startOrigin,
} from "./lib.mjs";

const { server } = await startOrigin(18703, "fault-origin", { closeEachResponse: true });
const device = await enrol("Fault", "computer");
const host = `${device.joined.subdomain}.${DOMAIN}`;
const config = (logPath) =>
  frpcConfig({
    device,
    ticket: device.ticket(),
    subdomain: device.joined.subdomain,
    localPort: 18703,
    logPath,
  });
const lines = (frpc, pattern) =>
  frpc
    .log()
    .split("\n")
    .filter((l) => pattern.test(l))
    .join("\n");

// 1. Slow plugin: Login takes 3 s inside the registry; it must answer t3x:busy at 1.5 s while /v1/info stays fast.
say(
  `touch /tmp/slow-login -> ${compose("exec", "-T", "registry", "touch", "/tmp/slow-login").status}`,
);
const slow = new Frpc("slow", config);
const infoTimes = [];
const probeEnd = Date.now() + 4000;
while (Date.now() < probeEnd) {
  const started = performance.now();
  const response = await fetch(`${ORIGIN}/v1/info`);
  await response.text();
  infoTimes.push({ status: response.status, ms: performance.now() - started });
  await sleep(200);
}
say(
  `while Login is stuck, GET /v1/info x${infoTimes.length}: statuses=${[...new Set(infoTimes.map((t) => t.status))]} max=${Math.max(...infoTimes.map((t) => t.ms)).toFixed(1)} ms`,
);
say(`slow-Login frpc log:\n${lines(slow, /login|error/i)}`);
const registryLogs = compose("logs", "registry", "--no-log-prefix", "--since", "1m").stdout;
say(
  `registry log: ${registryLogs
    .split("\n")
    .filter((l) => /plugin_timeout/.test(l))
    .slice(0, 3)
    .join(" | ")}`,
);
await slow.stop();
compose("exec", "-T", "registry", "rm", "-f", "/tmp/slow-login");

// 2. Registry outage with a running tunnel: every op fails closed; restart brings it back by itself.
const tunnel = new Frpc("outage", config);
await tunnel.waitFor(/start proxy success/);
say(`tunnel up, GET -> ${(await get(host)).status}`);
const stoppedAt = Date.now();
say(`docker compose stop registry -> ${compose("stop", "registry").status}`);
const downProbe = await get(host).catch((error) => ({
  status: `error ${error.cause?.code ?? error.message}`,
}));
say(`request while the registry is down (pooled connection) -> ${downProbe.status}`);
const sawPing = await tunnel.waitFor(
  /pong message contains error: send Ping request to plugin error/,
  50_000,
);
say(
  `Ping while down: ${sawPing === null ? "not seen in 50 s" : `after ${((sawPing.at - stoppedAt) / 1000).toFixed(1)} s`}`,
);
await sleep(6000);
say(`frpc log while down:\n${lines(tunnel, /error/i)}`);
const downGet = await get(host);
say(
  `request after Ping failed (no tunnel) -> ${downGet.status} (${JSON.stringify(downGet.text.slice(0, 40))})`,
);
const startedAt = Date.now();
say(`docker compose start registry -> ${compose("start", "registry").status}`);
const back = await tunnel.waitFor(/login to server success/, 60_000);
say(
  `frpc logged in again ${back === null ? "NEVER" : `${((back.at - startedAt) / 1000).toFixed(1)} s after the registry was started`}`,
);
await sleep(500);
say(`request after recovery -> ${(await get(host)).status}`);
await tunnel.stop();
server.close();
