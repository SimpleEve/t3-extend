// Runs INSIDE the registry container (s7-plugin-load.mjs hands it over with `node -e`). Env: MODE=api|probe, CFG=json.
// api:   hammers the public API (:8080) with join attempts that fail late, each from a different forged client IP,
//        so no rate limit shortcuts the work: JWK parse + ES256 verify + SQLite lookup per request.
// probe: posts Login requests to the plugin (:8081) one after another and prints the latency percentiles.
import * as NodeHttp from "node:http";

import { generateDeviceKey, signRequestProof } from "/app/proof.mjs";

const cfg = JSON.parse(process.env.CFG);
const agent = new NodeHttp.Agent({ keepAlive: true, maxSockets: cfg.concurrency });

function post(port, path, headers, body) {
  return new Promise((resolve) => {
    const started = performance.now();
    const req = NodeHttp.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent,
        headers: { "content-length": body.length, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            ms: performance.now() - started,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", () => resolve({ status: 0, ms: performance.now() - started }));
    req.end(body);
  });
}

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const summary = (label, results) => {
  const ms = results.map((r) => r.ms).toSorted((a, b) => a - b);
  const statuses = {};
  for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  console.log(`${label} first body: ${results[0]?.body}`);
  console.log(
    `${label}: n=${ms.length} statuses=${JSON.stringify(statuses)} p50=${percentile(ms, 50).toFixed(1)} p95=${percentile(ms, 95).toFixed(1)} p99=${percentile(ms, 99).toFixed(1)} max=${ms.at(-1).toFixed(1)} ms`,
  );
};

const until = Date.now() + cfg.seconds * 1000;

if (process.env.MODE === "api") {
  const key = generateDeviceKey();
  let counter = 0;
  const results = [];
  const worker = async () => {
    while (Date.now() < until) {
      counter += 1;
      const body = Buffer.from(
        JSON.stringify({
          invite: "AAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
          device: { name: `load-${counter}`, kind: "phone", jwk: key.jwk },
        }),
      );
      const proof = signRequestProof({
        privateKey: key.privateKey,
        jwk: key.jwk,
        method: "POST",
        htu: `${cfg.origin}/v1/join`,
        body,
      });
      results.push(
        await post(
          8080,
          "/v1/join",
          {
            "content-type": "application/json",
            "t3x-proof": proof,
            "x-t3x-client-ip": `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`,
          },
          body,
        ),
      );
    }
  };
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
  summary("api", results);
} else {
  const body = Buffer.from(
    JSON.stringify({ op: "Login", content: { user: cfg.user, metas: { t3x_ticket: cfg.ticket } } }),
  );
  const results = [];
  while (Date.now() < until) {
    results.push(
      await post(
        8081,
        "/frps?op=Login&version=0.1.0",
        { "content-type": "application/json" },
        body,
      ),
    );
  }
  summary("plugin", results);
}
