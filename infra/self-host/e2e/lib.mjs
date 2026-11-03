// Helpers for the 8.1 end-to-end checks against the t3x-p81 compose project (docker-compose.test.yml).
// Run the scripts with NODE_EXTRA_CA_CERTS pointing at Caddy's root certificate; nothing touches the system trust store.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { generateDeviceKey, signRequestProof, signTicket } from "../registry/proof.mjs";

export const EVIDENCE = process.env.T3X_E2E_DIR ?? "/tmp/t3x-p81";
export const PORT = Number(process.env.T3X_E2E_PORT ?? 18443);
export const DOMAIN = "t3.localhost";
export const ORIGIN = `https://${DOMAIN}:${PORT}`;
export const PROJECT = "t3x-p81";
const SELF_HOST = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const COMPOSE_ENV = {
  T3X_DATA_DIR: NodePath.join(EVIDENCE, "data"),
  T3X_COMPOSE_FILES: "docker-compose.yml:docker-compose.test.yml",
  T3X_PROJECT: PROJECT,
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const stamp = () => new Date().toISOString();
export const say = (text) => console.log(`${stamp()} ${text}`);

export function run(command, args, { env = {}, input } = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** `./t3x ...` against the test project. */
export function t3x(...args) {
  return run(NodePath.join(SELF_HOST, "t3x"), args, { env: COMPOSE_ENV });
}

export function compose(...args) {
  return run("docker", [
    "compose",
    "-p",
    PROJECT,
    "--env-file",
    NodePath.join(EVIDENCE, "data/.env"),
    "-f",
    NodePath.join(SELF_HOST, "docker-compose.yml"),
    "-f",
    NodePath.join(SELF_HOST, "docker-compose.test.yml"),
    ...args,
  ]);
}

export function cliInvite(kind) {
  const result = t3x("invite", "--kind", kind, "--no-qr");
  const line = result.stdout.split("\n").find((l) => l.startsWith("t3x1."));
  if (line === undefined) throw new Error(`no invite: ${result.stdout} ${result.stderr}`);
  return line.trim();
}

export function decodeInviteString(text) {
  return JSON.parse(Buffer.from(text.slice(5), "base64url").toString("utf8"));
}

export class Device {
  constructor(name, kind) {
    this.name = name;
    this.kind = kind;
    Object.assign(this, generateDeviceKey());
  }

  async request(method, path, { json, headers = {}, proof = {}, signedPath = path } = {}) {
    const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    const token = signRequestProof({
      privateKey: this.privateKey,
      ...(this.joining ? { jwk: this.jwk } : { kid: this.id }),
      method,
      htu: `${ORIGIN}${signedPath}`,
      body: body ?? Buffer.alloc(0),
      ...proof,
    });
    const started = performance.now();
    const response = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: {
        "t3x-proof": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return {
      status: response.status,
      json: parsed,
      text,
      headers: response.headers,
      ms: performance.now() - started,
    };
  }

  async join(inviteString) {
    const invite = decodeInviteString(inviteString);
    this.joining = true;
    try {
      const response = await this.request("POST", "/v1/join", {
        json: {
          invite: `${invite.i}.${invite.s}`,
          device: { name: this.name, kind: this.kind, jwk: this.jwk },
        },
      });
      if (response.status === 201) Object.assign(this, { joined: response.json });
      return response;
    } finally {
      this.joining = false;
    }
  }

  ticket(overrides = {}) {
    return signTicket({
      privateKey: this.privateKey,
      kid: this.id,
      rid: this.joined.registryId,
      sub: this.joined.subdomain,
      gen: this.createdAt,
      iat: Math.floor(Date.now() / 1000),
      ...overrides,
    });
  }
}

/** A joined device, with the registration time the ticket needs. */
export async function enrol(name, kind) {
  const device = new Device(name, kind);
  const response = await device.join(cliInvite(kind));
  if (response.status !== 201) throw new Error(`join failed: ${response.status} ${response.text}`);
  const listing = await device.request("GET", "/v1/devices");
  device.createdAt = listing.json.devices.find((d) => d.id === device.id).createdAt;
  return device;
}

export function recordPid(label, pid) {
  NodeFS.appendFileSync(NodePath.join(EVIDENCE, "pids.txt"), `${stamp()} ${label} ${pid}\n`);
}

/** A tiny HTTP origin standing in for the T3 server behind frpc. */
export function startOrigin(port, label = "origin", { closeEachResponse = false } = {}) {
  const seen = [];
  const server = NodeHttp.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, {
      "content-type": "text/plain",
      ...(closeEachResponse ? { connection: "close" } : {}),
    });
    res.end(`${label} ok\n`);
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, seen })),
  );
}

export function frpcConfig({
  device,
  ticket,
  subdomain,
  localPort,
  poolCount,
  logPath,
  extra = "",
  user,
}) {
  return `serverAddr = "${DOMAIN}"
serverPort = ${PORT}
user = "${user ?? device.id.slice(0, 16)}"
loginFailExit = false
metadatas.t3x_ticket = "${ticket}"
log.to = "${logPath}"
log.level = "info"

transport.protocol = "wss"
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90
transport.tls.trustedCaFile = "${NodePath.join(EVIDENCE, "ca/root.crt")}"
${poolCount === undefined ? "" : `transport.poolCount = ${poolCount}`}
${extra}

[[proxies]]
name = "t3x"
type = "http"
localIP = "127.0.0.1"
localPort = ${localPort}
subdomain = "${subdomain}"
`;
}

export class Frpc {
  constructor(label, config) {
    this.label = label;
    this.logPath = NodePath.join(EVIDENCE, `frpc-${label}.log`);
    const configPath = NodePath.join(EVIDENCE, `frpc-${label}.toml`);
    NodeFS.writeFileSync(configPath, config(this.logPath), { mode: 0o600 });
    NodeFS.writeFileSync(this.logPath, "");
    this.child = NodeChildProcess.spawn(NodePath.join(EVIDENCE, "bin/frpc"), ["-c", configPath], {
      stdio: "ignore",
    });
    recordPid(`frpc-${label}`, this.child.pid);
  }

  log() {
    return NodeFS.readFileSync(this.logPath, "utf8");
  }

  /** Resolves when `pattern` has matched at least `occurrence` times in the log. */
  async waitFor(pattern, timeoutMs = 20_000, occurrence = 1) {
    const global = new RegExp(pattern.source, "g");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const matches = [...this.log().matchAll(global)];
      if (matches.length >= occurrence) return { match: matches[occurrence - 1], at: Date.now() };
      await sleep(25);
    }
    return null;
  }

  stop() {
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) resolve();
      else this.child.once("exit", resolve);
    });
  }
}

export async function get(host, path = "/", headers = {}) {
  const response = await fetch(`https://${host}:${PORT}${path}`, { headers });
  return { status: response.status, text: await response.text(), headers: response.headers };
}
