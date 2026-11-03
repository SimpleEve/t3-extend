// What Caddy lets through: forged client addresses and Host headers, certificates for removed or unknown subdomains,
// and what the origin sees when the request arrives on port 443 (so Host carries no port).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";
import * as NodeURL from "node:url";

import {
  DOMAIN,
  EVIDENCE,
  Frpc,
  ORIGIN,
  PORT,
  enrol,
  frpcConfig,
  say,
  startOrigin,
} from "./lib.mjs";

const SELF_HOST = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const ca = NodeFS.readFileSync(NodePath.join(EVIDENCE, "ca/root.crt"));

// 2. A forged Host (SNI says t3.localhost, Host says something else) never reaches the registry.
function request({ host, path = "/", servername = host, headers = {} }) {
  return new Promise((resolve) => {
    const req = NodeHttps.request(
      { host: "127.0.0.1", port: PORT, path, servername, ca, headers: { host, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", (error) => resolve({ error: error.code ?? error.message }));
    req.end();
  });
}
const forged = await request({ host: "evil.example", servername: DOMAIN, path: "/v1/info" });
say(`GET /v1/info with SNI ${DOMAIN} but Host: evil.example -> ${JSON.stringify(forged)}`);

const forgedForwarded = await request({
  host: DOMAIN,
  path: "/v1/info",
  headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
});
say(
  `GET /v1/info with forged X-Forwarded-Host/Proto -> ${forgedForwarded.status} ${forgedForwarded.text}`,
);

// 1. A forged X-T3x-Client-IP must not give a fresh rate-limit bucket: /v1/info allows 60 per minute per address.
const statuses = [];
for (let i = 0; i < 70; i += 1) {
  const response = await fetch(`${ORIGIN}/v1/info`, {
    headers: { "x-t3x-client-ip": `203.0.113.${i + 1}`, "x-forwarded-for": `198.51.100.${i + 1}` },
  });
  statuses.push(response.status);
}
say(
  `70 x GET /v1/info, each with its own forged X-T3x-Client-IP and X-Forwarded-For: ${statuses.filter((s) => s === 200).length} x 200, ${statuses.filter((s) => s === 429).length} x 429 (first 429 at request ${statuses.indexOf(429) + 1})`,
);

// 3. Certificates are only issued for registered subdomains.
function handshake(servername) {
  return new Promise((resolve) => {
    const socket = NodeTls.connect({ host: "127.0.0.1", port: PORT, servername, ca }, () => {
      const subject = socket.getPeerCertificate().subject?.CN;
      socket.end();
      resolve(`handshake ok (certificate for ${subject})`);
    });
    socket.on("error", (error) => resolve(`handshake refused (${error.code ?? error.message})`));
  });
}
const gone = await enrol("Gone", "computer");
const goneSub = gone.joined.subdomain;
const keeper = await enrol("Keeper", "computer");
const removed = await keeper.request("DELETE", `/v1/devices/${gone.id}`);
say(`removed ${goneSub} before anyone asked for its certificate: ${removed.status}`);
say(`TLS ${goneSub}.${DOMAIN} (removed, tombstoned): ${await handshake(`${goneSub}.${DOMAIN}`)}`);
say(
  `TLS ${keeper.joined.subdomain}.${DOMAIN} (registered): ${await handshake(`${keeper.joined.subdomain}.${DOMAIN}`)}`,
);
say(
  `TLS nobody-registered-this.${DOMAIN} (unknown): ${await handshake(`nobody-registered-this.${DOMAIN}`)}`,
);
say(`TLS evil.example (other domain): ${await handshake("evil.example")}`);

// 4. Port 443 inside the compose network: Host has no port. The host cannot bind 443, so go through a one-off container.
const { server, seen } = await startOrigin(18706, "p443-origin", { closeEachResponse: true });
const tunnel = new Frpc("p443", (logPath) =>
  frpcConfig({
    device: keeper,
    ticket: keeper.ticket(),
    subdomain: keeper.joined.subdomain,
    localPort: 18706,
    logPath,
  }),
);
await tunnel.waitFor(/start proxy success/);
const inNetwork = await new Promise((resolve) => {
  const args = [
    "compose",
    "-p",
    "t3x-p81",
    "--env-file",
    NodePath.join(EVIDENCE, "data/.env"),
    "-f",
    NodePath.join(SELF_HOST, "docker-compose.yml"),
    "-f",
    NodePath.join(SELF_HOST, "docker-compose.test.yml"),
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "-v",
    `${NodePath.join(EVIDENCE, "ca")}:/ca:ro`,
    "-v",
    `${NodePath.join(SELF_HOST, "e2e/probe-in-network.cjs")}:/probe.cjs:ro`,
    "--entrypoint",
    "node",
    "registry",
    "/probe.cjs",
    `${keeper.joined.subdomain}.${DOMAIN}`,
    DOMAIN,
  ];
  const child = NodeChildProcess.spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] });
  const chunks = [];
  child.stdout.on("data", (c) => chunks.push(c));
  child.on("exit", () => resolve(Buffer.concat(chunks).toString()));
});
say(`from inside the network, caddy:443 (no port in Host):\n${inNetwork}`);
const last = seen.at(-1);
say(
  `the origin saw: ${JSON.stringify({ host: last?.headers.host, xff: last?.headers["x-forwarded-for"], proto: last?.headers["x-forwarded-proto"], clientIp: last?.headers["x-t3x-client-ip"] })}`,
);
await tunnel.stop();
server.close();
