// (1) Registry stopped and started again under a running tunnel: when does frpc recover?
// (2) NewProxy alone against a dead plugin: a throwaway frps on the host that only asks the plugin about NewProxy.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DOMAIN,
  EVIDENCE,
  Frpc,
  compose,
  enrol,
  frpcConfig,
  get,
  recordPid,
  say,
  sleep,
  startOrigin,
} from "./lib.mjs";

const { server } = await startOrigin(18704, "recovery-origin", { closeEachResponse: true });
const device = await enrol("Recover", "computer");
const host = `${device.joined.subdomain}.${DOMAIN}`;
const tunnel = new Frpc("recover", (logPath) =>
  frpcConfig({
    device,
    ticket: device.ticket(),
    subdomain: device.joined.subdomain,
    localPort: 18704,
    logPath,
  }),
);
await tunnel.waitFor(/start proxy success/);
say(`tunnel up, GET -> ${(await get(host)).status}`);

compose("stop", "registry");
const stoppedAt = Date.now();
await tunnel.waitFor(/pong message contains error: send Ping request to plugin error/, 50_000);
await sleep(3000);
say(`tunnel down: GET -> ${(await get(host)).status}`);
compose("start", "registry");
const startedAt = Date.now();
const second = await tunnel.waitFor(/start proxy success/, 90_000, 2);
say(
  `registry started ${((startedAt - stoppedAt) / 1000).toFixed(1)} s after stop; frpc re-registered its proxy ${second === null ? "NEVER" : `${((second.at - startedAt) / 1000).toFixed(1)} s after the registry was started`}`,
);
say(`GET after recovery -> ${(await get(host)).status}`);
await tunnel.stop();

// (2)
const frpsBinary = NodeFS.readdirSync(NodePath.join(EVIDENCE, "frp-dl/ex")).map((d) =>
  NodePath.join(EVIDENCE, "frp-dl/ex", d, "frps"),
)[0];
NodeFS.writeFileSync(
  NodePath.join(EVIDENCE, "frps-newproxy.toml"),
  `bindPort = 17000
vhostHTTPPort = 17080
subDomainHost = "${DOMAIN}"
log.to = "${EVIDENCE}/frps-newproxy.log"
log.level = "info"
[[httpPlugins]]
name = "dead"
addr = "127.0.0.1:1"
path = "/frps"
ops = ["NewProxy"]
`,
);
const frps = NodeChildProcess.spawn(
  frpsBinary,
  ["-c", NodePath.join(EVIDENCE, "frps-newproxy.toml")],
  { stdio: "ignore" },
);
recordPid("frps-newproxy", frps.pid);
await sleep(800);
NodeFS.writeFileSync(
  NodePath.join(EVIDENCE, "frpc-newproxy.toml"),
  `serverAddr = "127.0.0.1"
serverPort = 17000
loginFailExit = false
log.to = "${EVIDENCE}/frpc-newproxy.log"
log.level = "info"
[[proxies]]
name = "t3x"
type = "http"
localIP = "127.0.0.1"
localPort = 18704
subdomain = "np"
`,
  { mode: 0o600 },
);
NodeFS.writeFileSync(`${EVIDENCE}/frpc-newproxy.log`, "");
const frpc = NodeChildProcess.spawn(
  NodePath.join(EVIDENCE, "bin/frpc"),
  ["-c", NodePath.join(EVIDENCE, "frpc-newproxy.toml")],
  { stdio: "ignore" },
);
recordPid("frpc-newproxy", frpc.pid);
await sleep(4000);
say(
  `NewProxy alone, plugin unreachable (frps on the host, only NewProxy goes to the plugin):\n${NodeFS.readFileSync(
    `${EVIDENCE}/frpc-newproxy.log`,
    "utf8",
  )
    .split("\n")
    .filter((l) => /login|proxy|error/i.test(l))
    .join("\n")}`,
);
const routed = await fetch("http://127.0.0.1:17080/", { headers: { host: `np.${DOMAIN}` } });
say(`request to the vhost for that proxy -> ${routed.status}`);
frpc.kill("SIGTERM");
frps.kill("SIGTERM");
server.close();
