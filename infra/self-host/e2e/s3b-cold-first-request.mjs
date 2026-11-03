// The cost of poolCount = 0 that traffic hides: the very first request on a tunnel nobody has used yet.
import * as NodeHttps from "node:https";

import { DOMAIN, Frpc, PORT, enrol, frpcConfig, say, sleep, startOrigin } from "./lib.mjs";

const ask = (host) =>
  new Promise((resolve) => {
    const started = performance.now();
    const req = NodeHttps.request(
      {
        host,
        port: PORT,
        path: "/",
        agent: false,
        headers: { connection: "close", host: `${host}:${PORT}` },
        servername: host,
      },
      (res) => {
        const ttfb = performance.now() - started;
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, ttfb }));
      },
    );
    req.on("error", () => resolve({ status: "error", ttfb: performance.now() - started }));
    req.end();
  });

const { server } = await startOrigin(18702, "cold-origin", { closeEachResponse: true });
const results = { default: [], pool0: [] };
for (let round = 0; round < 8; round += 1) {
  for (const [label, poolCount] of [
    ["default", undefined],
    ["pool0", 0],
  ]) {
    const device = await enrol(`Cold ${label} ${round}`, "computer");
    const host = `${device.joined.subdomain}.${DOMAIN}`;
    const frpc = new Frpc(`cold-${label}-${round}`, (logPath) =>
      frpcConfig({
        device,
        ticket: device.ticket(),
        subdomain: device.joined.subdomain,
        localPort: 18702,
        logPath,
        poolCount,
      }),
    );
    await frpc.waitFor(/start proxy success/);
    await ask(host).catch(() => {}); // not counted: this one pays for the certificate
    await frpc.stop();
    const again = new Frpc(`cold2-${label}-${round}`, (logPath) =>
      frpcConfig({
        device,
        ticket: device.ticket(),
        subdomain: device.joined.subdomain,
        localPort: 18702,
        logPath,
        poolCount,
      }),
    );
    await again.waitFor(/start proxy success/);
    await sleep(1500);
    const first = await ask(host);
    results[label].push(first);
    await again.stop();
  }
}
for (const [label, list] of Object.entries(results)) {
  const times = list.map((r) => r.ttfb).sort((a, b) => a - b);
  say(
    `${label}: first request on an idle tunnel: statuses=${[...new Set(list.map((r) => r.status))]} ttfb ms = ${times.map((t) => t.toFixed(1)).join(", ")} (median ${times[Math.floor(times.length / 2)].toFixed(1)})`,
  );
}
server.close();
