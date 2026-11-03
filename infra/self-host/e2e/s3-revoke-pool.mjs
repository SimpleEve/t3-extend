// poolCount default (1) vs 0: first-byte latency of fresh connections, and what happens right after the device is removed.
import * as NodeHttps from "node:https";

import { DOMAIN, Frpc, PORT, enrol, frpcConfig, say, sleep, startOrigin, t3x } from "./lib.mjs";

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
    req.on("error", (error) =>
      resolve({ status: `error:${error.code}`, ttfb: performance.now() - started }),
    );
    req.end();
  });
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return `n=${sorted.length} median=${pick(0.5).toFixed(1)} ms p90=${pick(0.9).toFixed(1)} ms mean=${(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)} ms`;
};

const { server } = await startOrigin(18701, "pool-origin", { closeEachResponse: true });
const variants = [
  { label: "default", poolCount: undefined },
  { label: "pool0", poolCount: 0 },
];
for (const variant of variants) {
  variant.device = await enrol(`Pool ${variant.label}`, "computer");
  variant.host = `${variant.device.joined.subdomain}.${DOMAIN}`;
  variant.frpc = new Frpc(variant.label, (logPath) =>
    frpcConfig({
      device: variant.device,
      ticket: variant.device.ticket(),
      subdomain: variant.device.joined.subdomain,
      localPort: 18701,
      logPath,
      poolCount: variant.poolCount,
    }),
  );
  await variant.frpc.waitFor(/start proxy success/);
  variant.ttfb = [];
}
say(`both tunnels up: ${variants.map((v) => v.host).join(", ")}`);
await sleep(1500);
for (const variant of variants) await ask(variant.host); // warm TLS certificates

for (let round = 0; round < 40; round += 1) {
  for (const variant of round % 2 === 0 ? variants : [...variants].reverse()) {
    const result = await ask(variant.host);
    if (result.status !== 200) say(`unexpected ${result.status} for ${variant.label}`);
    variant.ttfb.push(result.ttfb);
  }
  await sleep(150);
}
for (const variant of variants)
  say(`first byte, new connection, ${variant.label}: ${stats(variant.ttfb)}`);

// Remove both at the same moment, then probe each every 100 ms.
const removedAt = Date.now();
for (const variant of variants) {
  const result = t3x("revoke", variant.device.id);
  say(`revoke ${variant.label}: ${result.stdout.split("\n")[0]}`);
}
const t0 = Date.now();
const timeline = { default: [], pool0: [] };
const revokedAt = {};
while (Date.now() - t0 < 40_000 && Object.keys(revokedAt).length < 2) {
  for (const variant of variants) {
    const result = await ask(variant.host);
    const entry = timeline[variant.label];
    entry.push({ status: result.status, at: Date.now() - t0, tookMs: Math.round(result.ttfb) });
    if (
      revokedAt[variant.label] === undefined &&
      /pong message contains error: t3x:revoked/.test(variant.frpc.log())
    )
      revokedAt[variant.label] = Date.now() - t0;
  }
  await sleep(100);
}
for (const variant of variants) {
  say(
    `after removal, ${variant.label}: every probe (status, ms since removal, took ms) ${JSON.stringify(timeline[variant.label])}; frpc saw 'pong message contains error: t3x:revoked' at ${revokedAt[variant.label] ?? "never"} ms`,
  );
  say(
    `frpc ${variant.label} log tail:\n${variant.frpc
      .log()
      .split("\n")
      .filter((l) => /error|login|Ping|reconnect/i.test(l))
      .slice(-6)
      .join("\n")}`,
  );
}
void removedAt;
await Promise.all(variants.map((v) => v.frpc.stop()));
server.close();
