// Helpers shared by the registry tests and the end-to-end checks: a fake clock, a registry served on an
// ephemeral loopback port, and a "device" that signs requests the way a real one will.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Store } from "./db.mjs";
import { decodeInvite } from "./invites.mjs";
import { createApiServer } from "./server.mjs";
import { generateDeviceKey, signRequestProof } from "./proof.mjs";

const { mkdtempSync, rmSync } = NodeFS;
const { request: httpRequest } = NodeHttp;
const { tmpdir } = NodeOS;
const { join } = NodePath;

export const TEST_ORIGIN = "https://registry.test";

export function createClock(start = 1_800_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(seconds) {
      current += seconds;
    },
  };
}

export function testConfig(overrides = {}) {
  return {
    publicOrigin: TEST_ORIGIN,
    domain: "registry.test",
    publicPort: 443,
    ...overrides,
  };
}

export function rawRequest({ port, method = "GET", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A registry on a temp-file database (so a second connection can race it) and an ephemeral port. */
export async function startTestRegistry({
  clock = createClock(),
  config = testConfig(),
  log,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "t3x-registry-test-"));
  const dbPath = join(dir, "registry.db");
  const store = Store.open(dbPath);
  const logs = [];
  const { server, api } = createApiServer({
    store,
    config,
    now: clock.now,
    log: log ?? ((entry) => logs.push(entry)),
  });
  // Registered after the API's own listener, so the in-flight count is already updated when this fires.
  let requests = 0;
  const waiters = [];
  server.on("request", () => {
    requests += 1;
    for (const waiter of waiters) if (requests >= waiter.count) waiter.resolve();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    store,
    config,
    clock,
    api,
    port,
    dbPath,
    logs,
    server,
    /** Resolves once the server has received `count` requests in total. */
    requestsReceived: (count) =>
      new Promise((resolve) => (requests >= count ? resolve() : waiters.push({ count, resolve }))),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const jsonBody = (value) => (value === undefined ? undefined : Buffer.from(JSON.stringify(value)));

export class FakeDevice {
  constructor(registry, { name = "Device", kind = "computer", ip = "203.0.113.7" } = {}) {
    this.registry = registry;
    this.name = name;
    this.kind = kind;
    this.ip = ip;
    Object.assign(this, generateDeviceKey());
  }

  /** Signs and sends. `overrides` can break any part of the request on purpose. */
  async send(
    method,
    path,
    { json, rawBody, signBody, proof = {}, headers = {}, signedPath = path, auth = "kid" } = {},
  ) {
    const body = rawBody ?? jsonBody(json);
    const signature = signRequestProof({
      privateKey: this.privateKey,
      ...(auth === "kid" ? { kid: this.id } : { jwk: this.jwk }),
      method,
      htu: `${this.registry.config.publicOrigin}${signedPath}`,
      body: signBody ?? body ?? Buffer.alloc(0),
      iat: this.registry.clock.now(),
      ...proof,
    });
    return rawRequest({
      port: this.registry.port,
      method,
      path,
      body,
      headers: {
        "x-t3x-client-ip": this.ip,
        "t3x-proof": signature,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", "content-length": String(body.length) }),
        ...headers,
      },
    });
  }

  /** Redeems an invite string (or, if it does not decode, sends it as given) and registers this device. */
  join(inviteString, extra = {}) {
    const invite = decodeInvite(inviteString);
    return this.send("POST", "/v1/join", {
      auth: "jwk",
      json: {
        invite: invite === null ? inviteString : `${invite.id}.${invite.secret}`,
        device: { name: this.name, kind: this.kind, jwk: this.jwk, ...extra },
      },
    });
  }
}

/** Creates an invite straight in the store (as `./t3x invite` does) and returns the invite string. */
export async function cliInvite(registry, kind = "any") {
  const { encodeInvite } = await import("./invites.mjs");
  const invite = registry.store.createInvite({ kind, createdBy: "cli", now: registry.clock.now() });
  return encodeInvite({
    origin: registry.config.publicOrigin,
    registryId: registry.store.registryId,
    id: invite.id,
    secret: invite.secret,
    kind,
    expiresAt: invite.expiresAt,
  });
}

/** A registered device, ready to sign requests. */
export async function enroll(registry, options) {
  const device = new FakeDevice(registry, options);
  const result = await device.join(await cliInvite(registry, device.kind));
  if (result.status !== 201) throw new Error(`enroll failed: ${result.status} ${result.text}`);
  device.joined = result.json;
  return device;
}
