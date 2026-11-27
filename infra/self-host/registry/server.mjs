// The registry's public API (/v1/*), plus the process entry point that also starts the frps plugin
// listener (:8081) and the Caddy `ask` listener (:8082). Spec: research/self-host-device-keys.md 3.3, 3.4, 3.12.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeURL from "node:url";

import { createAskServer } from "./ask.mjs";
import {
  MAX_VISIBILITY_DEVICES,
  Store,
  StoreError,
  VISIBILITY_MODES,
  isVisibleTo,
  nowSeconds,
} from "./db.mjs";
import { encodeInvite, parseRedemption } from "./invites.mjs";
import { createPluginServer } from "./plugin.mjs";
import {
  ProofError,
  canonicalOrigin,
  jwkThumbprint,
  normalizeJwk,
  originParts,
  parseRequestProof,
  publicKeyFromJwk,
  verifyRequestProof,
} from "./proof.mjs";
import { RateLimiter } from "./ratelimit.mjs";
import { normalizeDeviceName } from "./subdomain.mjs";

const { createServer } = NodeHttp;
const { isIP } = NodeNet;
const { domainToASCII } = NodeURL;

export const BODY_LIMIT_BYTES = 4096;
export const MAX_IN_FLIGHT = 128;
const ONLINE_WINDOW_SECONDS = 90;
const ENVIRONMENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{43}$/;

/** The response for each error code. The descriptions are fixed: nothing from the request is echoed. */
const ERRORS = {
  invalid_request: [400, "The request is malformed."],
  invite_invalid: [400, "The invite is not valid."],
  name_invalid: [400, "The device name is not valid."],
  invalid_proof: [401, "The request signature is not valid."],
  device_unknown: [401, "This device is not registered."],
  forbidden: [403, "This device is not allowed to do that."],
  not_found: [404, "Not found."],
  method_not_allowed: [405, "Method not allowed."],
  invite_used: [409, "The invite has already been used."],
  kind_mismatch: [409, "The invite is for a different kind of device."],
  name_taken: [409, "The name or subdomain is already taken."],
  device_exists: [409, "This device key is already registered."],
  too_many_invites: [409, "Too many open invites."],
  invite_expired: [410, "The invite has expired."],
  rate_limited: [429, "Too many requests."],
  internal: [500, "Internal error."],
  busy: [503, "The registry is busy."],
};

class HttpError extends Error {
  constructor(code, extraHeaders = {}) {
    super(code);
    this.code = code;
    this.extraHeaders = extraHeaders;
  }
}

/** Reads and validates the environment; throws when the public origin cannot be canonicalised. */
export function loadConfig(env = process.env) {
  const publicOrigin = canonicalOrigin(env.T3X_PUBLIC_ORIGIN ?? "");
  if (publicOrigin.length > 80) throw new Error("T3X_PUBLIC_ORIGIN is longer than 80 characters");
  const { host, port } = originParts(publicOrigin);
  const number = (name, fallback) => (env[name] === undefined ? fallback : Number(env[name]));
  return {
    publicOrigin,
    domain: host,
    publicPort: port,
    ntfyInstalled: env.T3X_NTFY_ENABLED === "1",
    dbPath: env.T3X_DB_PATH ?? "/data/registry.db",
    bindHost: env.T3X_BIND_HOST ?? "0.0.0.0",
    apiPort: number("T3X_API_PORT", 8080),
    pluginPort: number("T3X_PLUGIN_PORT", 8081),
    askPort: number("T3X_ASK_PORT", 8082),
  };
}

/** Where a computer is reachable through the tunnel. */
export function deviceUrl(config, subdomain) {
  return `https://${subdomain}.${config.domain}${config.publicPort === 443 ? "" : `:${config.publicPort}`}`;
}

/** Lowercase, port stripped, punycode, at most 255 characters. For logs only; never used in a decision. */
export function normalizeHostForLog(header) {
  if (typeof header !== "string") return "";
  const withoutPort = header.startsWith("[")
    ? header.slice(0, header.indexOf("]") + 1)
    : header.replace(/:\d*$/, "");
  return (domainToASCII(withoutPort.toLowerCase()) || withoutPort.toLowerCase()).slice(0, 255);
}

function clientIp(req) {
  const value = req.headers["x-t3x-client-ip"];
  return typeof value === "string" && isIP(value) !== 0 ? value.toLowerCase() : "unknown";
}

/**
 * 3.12 B: no Content-Length means no body; a declared length must be plain digits, within the limit, and match
 * what arrives. Past the limit we stop reading; the error reply carries `Connection: close`, which ends the socket.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const header = req.headers["content-length"];
    const declared = header === undefined ? 0 : /^\d{1,9}$/.test(header) ? Number(header) : -1;
    const refuse = () => {
      req.pause();
      reject(new HttpError("invalid_request"));
    };
    if (declared < 0 || declared > limit) {
      refuse();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > declared) {
        refuse();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => (size === declared ? resolve(Buffer.concat(chunks)) : refuse()));
    req.on("error", refuse);
    req.on("close", () => {
      if (!req.complete) refuse();
    });
  });
}

function parseJsonObject(body, allowed, required) {
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError("invalid_request");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HttpError("invalid_request");
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new HttpError("invalid_request");
  }
  return value;
}

const ROUTES = [
  ["GET", /^\/v1\/info$/, "info"],
  ["POST", /^\/v1\/join$/, "join"],
  ["GET", /^\/v1\/devices$/, "devices"],
  ["POST", /^\/v1\/invites$/, "createInvite"],
  ["GET", /^\/v1\/invites$/, "listInvites"],
  ["DELETE", /^\/v1\/invites\/([A-Za-z0-9_-]{11})$/, "deleteInvite"],
  ["DELETE", /^\/v1\/devices\/([A-Za-z0-9_-]{43})$/, "removeDevice"],
  ["PATCH", /^\/v1\/devices\/self$/, "patchSelf"],
  ["PUT", /^\/v1\/devices\/self\/visibility$/, "setVisibility"],
  ["PATCH", /^\/v1\/devices\/([A-Za-z0-9_-]{43})$/, "renameDevice"],
];

function matchRoute(method, path) {
  let allowed = null;
  for (const [routeMethod, pattern, name] of ROUTES) {
    const match = pattern.exec(path);
    if (match === null) continue;
    if (routeMethod === method) return { name, param: match[1] };
    allowed = routeMethod;
  }
  if (allowed !== null) throw new HttpError("method_not_allowed", { allow: allowed });
  throw new HttpError("not_found");
}

/**
 * @param {{store: Store, config: ReturnType<typeof loadConfig>, now?: () => number, log?: (entry: object) => void}} deps
 */
export function createApi({ store, config, now = nowSeconds, log = () => {} }) {
  const limits = {
    perIp: new RateLimiter({ limit: 300, windowSeconds: 60 }),
    info: new RateLimiter({ limit: 60, windowSeconds: 60 }),
    joinFailures: new RateLimiter({ limit: 10, windowSeconds: 600 }),
    perDevice: new RateLimiter({ limit: 120, windowSeconds: 60 }),
    inviteCreate: new RateLimiter({ limit: 10, windowSeconds: 3600 }),
  };
  let inFlight = 0;
  let lastHostWarning = 0;

  const rateLimited = (wait) => new HttpError("rate_limited", { "retry-after": String(wait) });

  /** Verifies T3X-Proof for every route except /info. Returns the signing device and the parsed key. */
  function authenticate(req, path, body, { forJoin }) {
    const fail = (reason, code = "invalid_proof") => {
      log({ event: "proof_rejected", reason, route: path });
      return new HttpError(code);
    };
    if (
      body.length > 0 &&
      !/^application\/json\s*(;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")
    ) {
      throw new HttpError("invalid_request");
    }
    let decoded;
    try {
      decoded = parseRequestProof(req.headers["t3x-proof"]);
    } catch (error) {
      throw fail(error instanceof ProofError ? error.reason : "malformed");
    }

    let device = null;
    let jwk;
    let deviceId;
    if (forJoin) {
      if (decoded.header.kid !== undefined) throw fail("kid_on_join");
      jwk = normalizeJwk(decoded.header.jwk);
      if (jwk === null) throw fail("bad_jwk");
      deviceId = jwkThumbprint(jwk);
    } else {
      if (decoded.header.jwk !== undefined) throw fail("jwk_outside_join");
      deviceId = decoded.header.kid;
      if (!DEVICE_ID.test(deviceId)) throw fail("bad_kid");
      device = store.getDevice(deviceId);
      if (device === null) throw fail("device_unknown", "device_unknown");
      jwk = device.jwk;
    }

    let proven;
    try {
      proven = verifyRequestProof(decoded, {
        publicKey: publicKeyFromJwk(jwk),
        method: req.method,
        htu: `${config.publicOrigin}${path}`,
        now: now(),
        body,
      });
    } catch (error) {
      throw fail(error instanceof ProofError ? error.reason : "verify_failed");
    }
    if (!store.recordJti(deviceId, proven.jti, proven.expiresAt)) throw fail("replay");

    if (!forJoin) {
      const wait = limits.perDevice.hit(deviceId, now());
      if (wait > 0) throw rateLimited(wait);
      store.touch(deviceId, "seen", now());
    }
    return { device, deviceId, jwk };
  }

  const requireComputer = (device) => {
    if (device.kind !== "computer") throw new HttpError("forbidden");
  };

  /** A device that is gone (null) hides nothing. */
  const canSee = (viewer, target) => target === null || isVisibleTo(target, viewer.id);

  /** Whether `viewer` may act on `target` by name or id: a device hidden from it does not exist for it. */
  const requireVisible = (viewer, target) => {
    if (!canSee(viewer, target)) throw new HttpError("not_found");
  };

  const publicDevice = (device, at, viewerId) => {
    const seen = store.withTouches(device);
    return {
      id: seen.id,
      name: seen.name,
      kind: seen.kind,
      jwk: seen.jwk,
      ...(seen.subdomain === null
        ? {}
        : { subdomain: seen.subdomain, url: deviceUrl(config, seen.subdomain) }),
      ...(seen.environmentId === null ? {} : { environmentId: seen.environmentId }),
      createdAt: seen.createdAt,
      lastSeenAt: seen.lastSeenAt ?? seen.createdAt,
      ...(seen.lastSyncAt === null ? {} : { lastSyncAt: seen.lastSyncAt }),
      ...(seen.kind === "computer"
        ? { online: (seen.lastTunnelAt ?? 0) > at - ONLINE_WINDOW_SECONDS }
        : {}),
      // Only a computer's own entry carries its setting, and only a registry that has the setting says so.
      ...(seen.id === viewerId && seen.kind === "computer" ? { visibility: seen.visibility } : {}),
    };
  };

  const handlers = {
    info: () => ({
      status: 200,
      body: {
        apiVersion: 1,
        registryId: store.registryId,
        domain: config.domain,
        publicPort: config.publicPort,
      },
    }),

    async join({ req, path, body }) {
      const { jwk, deviceId } = authenticate(req, path, body, { forJoin: true });
      const request = parseJsonObject(body, ["invite", "device"], ["invite", "device"]);
      if (typeof request.invite !== "string") throw new HttpError("invalid_request");
      const device = request.device;
      if (typeof device !== "object" || device === null || Array.isArray(device))
        throw new HttpError("invalid_request");
      const deviceKeys = Object.keys(device);
      if (
        deviceKeys.some((key) => !["name", "kind", "jwk", "environmentId"].includes(key)) ||
        !["name", "kind", "jwk"].every((key) => deviceKeys.includes(key))
      ) {
        throw new HttpError("invalid_request");
      }
      if (device.kind !== "computer" && device.kind !== "phone")
        throw new HttpError("invalid_request");
      const bodyJwk = normalizeJwk(device.jwk);
      if (bodyJwk === null) throw new HttpError("invalid_request");
      if (jwkThumbprint(bodyJwk) !== deviceId) throw new HttpError("invalid_proof");
      if (
        device.environmentId !== undefined &&
        !(typeof device.environmentId === "string" && ENVIRONMENT_ID.test(device.environmentId))
      ) {
        throw new HttpError("invalid_request");
      }
      const name = normalizeDeviceName(device.name);
      if (name === null) throw new HttpError("name_invalid");
      const redemption = parseRedemption(request.invite);
      if (redemption === null) throw new HttpError("invite_invalid");

      const joined = store.join({
        inviteId: redemption.id,
        secret: redemption.secret,
        device: { id: deviceId, name, kind: device.kind, jwk, environmentId: device.environmentId },
        now: now(),
      });
      log({
        event: "joined",
        deviceId,
        name: joined.device.name,
        kind: joined.device.kind,
        ip: clientIpOf(req),
      });
      const created = joined.device;
      return {
        status: 201,
        body: {
          registryId: store.registryId,
          deviceId,
          name: created.name,
          ...(created.subdomain === null
            ? {}
            : { subdomain: created.subdomain, url: deviceUrl(config, created.subdomain) }),
          rev: joined.rev,
        },
      };
    },

    devices({ req, path, body }) {
      const { deviceId, device } = authenticate(req, path, body, { forJoin: false });
      store.touch(deviceId, "sync", now());
      // Always the current body: `online` and the sync times change with the clock, not with `rev`,
      // so a validator keyed on `rev` would freeze them. Clients send no `If-None-Match`; one that
      // does is answered as if it had not.
      const at = now();
      const all = store.listDevices();
      // The list is per viewer: a computer hidden from the viewer is not in `devices`, so for the viewer
      // it is as if it had been removed. Its identity (never its name or address) still goes along in
      // `hiddenPeers`, because a computer that hides from this one may still sign in to it and needs its key
      // checked. A phone never checks a pass, so it gets none.
      const hiddenPeers =
        device.kind === "computer"
          ? all
              .filter((d) => !isVisibleTo(d, deviceId))
              .map((d) => ({ id: d.id, kind: d.kind, jwk: d.jwk }))
          : [];
      return {
        status: 200,
        body: {
          registryId: store.registryId,
          rev: store.rev,
          devices: all
            .filter((d) => isVisibleTo(d, deviceId))
            .map((d) => publicDevice(d, at, deviceId)),
          ...(hiddenPeers.length === 0 ? {} : { hiddenPeers }),
        },
      };
    },

    createInvite({ req, path, body }) {
      const { device } = authenticate(req, path, body, { forJoin: false });
      requireComputer(device);
      const request = parseJsonObject(body, ["kind"], ["kind"]);
      if (request.kind !== "computer" && request.kind !== "phone")
        throw new HttpError("invalid_request");
      const wait = limits.inviteCreate.hit(device.id, now());
      if (wait > 0) throw rateLimited(wait);
      const invite = store.createInvite({ kind: request.kind, createdBy: device.id, now: now() });
      log({ event: "invite_created", by: device.id, kind: request.kind, id: invite.id });
      return {
        status: 201,
        body: {
          id: invite.id,
          invite: encodeInvite({
            origin: config.publicOrigin,
            registryId: store.registryId,
            id: invite.id,
            secret: invite.secret,
            kind: request.kind,
            expiresAt: invite.expiresAt,
          }),
          expiresAt: invite.expiresAt,
        },
      };
    },

    listInvites({ req, path, body }) {
      const { device } = authenticate(req, path, body, { forJoin: false });
      requireComputer(device);
      return {
        status: 200,
        body: {
          invites: store
            .listOpenInvites(now())
            .filter((row) => canSee(device, store.getDevice(row.created_by)))
            .map((row) => ({
              id: row.id,
              kind: row.kind,
              createdBy: row.created_by,
              expiresAt: row.expires_at,
            })),
        },
      };
    },

    deleteInvite({ req, path, body, param }) {
      const { device } = authenticate(req, path, body, { forJoin: false });
      requireComputer(device);
      const invite = store.getInvite(param);
      if (invite !== null) requireVisible(device, store.getDevice(invite.created_by));
      if (!store.deleteInvite(param)) throw new HttpError("not_found");
      log({ event: "invite_cancelled", by: device.id, id: param });
      return { status: 204 };
    },

    removeDevice({ req, path, body, param }) {
      const { device } = authenticate(req, path, body, { forJoin: false });
      if (device.kind !== "computer" && param !== device.id) throw new HttpError("forbidden");
      requireVisible(device, store.getDevice(param));
      const removed = store.removeDevice(param, now());
      if (removed === null) throw new HttpError("not_found");
      log({ event: "device_removed", by: device.id, deviceId: param, name: removed.device.name });
      return { status: 200, body: { removedAt: removed.removedAt, rev: removed.rev } };
    },

    renameDevice({ req, path, body, param }) {
      const { device } = authenticate(req, path, body, { forJoin: false });
      if (device.kind !== "computer" && param !== device.id) throw new HttpError("forbidden");
      const request = parseJsonObject(body, ["name"], ["name"]);
      const name = normalizeDeviceName(request.name);
      if (name === null) throw new HttpError("name_invalid");
      requireVisible(device, store.getDevice(param));
      if (store.renameDevice(param, name) === null) throw new HttpError("not_found");
      return { status: 200, body: { id: param, name } };
    },

    patchSelf({ req, path, body }) {
      const { device } = authenticate(req, path, body, { forJoin: false });
      const request = parseJsonObject(body, ["environmentId"], ["environmentId"]);
      if (
        typeof request.environmentId !== "string" ||
        !ENVIRONMENT_ID.test(request.environmentId)
      ) {
        throw new HttpError("invalid_request");
      }
      const rev = store.setEnvironmentId(device.id, request.environmentId);
      if (rev === null) throw new HttpError("not_found");
      return { status: 200, body: { rev } };
    },

    setVisibility({ req, path, body }) {
      const { device } = authenticate(req, path, body, { forJoin: false });
      requireComputer(device);
      const request = parseJsonObject(body, ["mode", "deviceIds"], ["mode", "deviceIds"]);
      if (
        !VISIBILITY_MODES.includes(request.mode) ||
        !Array.isArray(request.deviceIds) ||
        request.deviceIds.length > MAX_VISIBILITY_DEVICES ||
        !request.deviceIds.every((id) => typeof id === "string" && DEVICE_ID.test(id))
      ) {
        throw new HttpError("invalid_request");
      }
      const rev = store.setVisibility(device.id, request.mode, request.deviceIds);
      if (rev === null) throw new HttpError("not_found");
      log({
        event: "visibility_set",
        by: device.id,
        mode: request.mode,
        count: request.deviceIds.length,
      });
      return { status: 200, body: { rev, visibility: store.getDevice(device.id).visibility } };
    },
  };

  const clientIpOf = (req) => clientIp(req);

  function send(res, status, body, headers = {}) {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "cache-control": "no-store",
      ...(body === undefined
        ? {}
        : { "content-type": "application/json", "content-length": Buffer.byteLength(text) }),
      ...headers,
    });
    res.end(text);
  }

  function sendError(res, error) {
    const [status, description] = ERRORS[error.code];
    send(res, status, { error: error.code, error_description: description }, error.extraHeaders);
  }

  /** @type {import("node:http").RequestListener} */
  async function requestListener(req, res) {
    if (inFlight >= MAX_IN_FLIGHT) {
      sendError(res, new HttpError("busy", { "retry-after": "1" }));
      return;
    }
    inFlight += 1;
    res.on("close", () => {
      inFlight -= 1;
    });
    const ip = clientIpOf(req);
    let joinAttempt = false;
    try {
      const wait = limits.perIp.hit(ip, now());
      if (wait > 0) throw rateLimited(wait);

      const rawUrl = req.url ?? "";
      if (rawUrl.includes("?")) throw new HttpError("invalid_request");
      const route = matchRoute(req.method ?? "", rawUrl);
      const host = normalizeHostForLog(req.headers.host);
      if (host !== config.domain && now() - lastHostWarning >= 60) {
        lastHostWarning = now();
        log({ level: "warn", event: "host_mismatch", host, expected: config.domain });
      }

      if (route.name === "info") {
        const infoWait = limits.info.hit(ip, now());
        if (infoWait > 0) throw rateLimited(infoWait);
      }
      if (route.name === "join") {
        joinAttempt = true;
        const joinWait = limits.joinFailures.retryAfter(ip, now());
        if (joinWait > 0) {
          joinAttempt = false;
          throw rateLimited(joinWait);
        }
      }

      if (req.headers["content-encoding"] !== undefined) throw new HttpError("invalid_request");
      const body = route.name === "info" ? Buffer.alloc(0) : await readBody(req, BODY_LIMIT_BYTES);
      const result = await handlers[route.name]({ req, path: rawUrl, body, param: route.param });
      send(res, result.status, result.body, result.headers);
      if (joinAttempt && result.status !== 201) limits.joinFailures.record(ip, now());
    } catch (caught) {
      let error = caught;
      if (error instanceof StoreError) error = new HttpError(error.code);
      if (!(error instanceof HttpError)) {
        log({
          level: "error",
          event: "internal_error",
          message: String(caught?.message ?? caught),
        });
        error = new HttpError("internal");
      }
      if (joinAttempt) limits.joinFailures.record(ip, now());
      res.setHeader("connection", "close");
      sendError(res, error);
    }
  }

  return {
    requestListener,
    limits,
    sweepLimits() {
      for (const limiter of Object.values(limits)) limiter.sweep(now());
    },
  };
}

export function createApiServer(deps) {
  const api = createApi(deps);
  const server = createServer(api.requestListener);
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return { server, api };
}

function startMaintenance({ store, api, now, log }) {
  const every = (ms, fn) =>
    setInterval(() => {
      try {
        fn();
      } catch (error) {
        log({
          level: "error",
          event: "maintenance_failed",
          message: String(error?.message ?? error),
        });
      }
    }, ms).unref();
  every(30_000, () => store.flushTouches());
  every(10 * 60_000, () => store.purge(now()));
  every(60_000, () => api.sweepLimits());
}

const stdoutLog = (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));

async function main() {
  const config = loadConfig();
  const store = Store.open(config.dbPath);
  const now = nowSeconds;
  const log = stdoutLog;
  const { server, api } = createApiServer({ store, config, now, log });
  const plugin = createPluginServer({ store, config, now, log });
  const ask = createAskServer({ store, config, log });
  startMaintenance({ store, api, now, log });
  await Promise.all(
    [
      [server, config.apiPort],
      [plugin, config.pluginPort],
      [ask, config.askPort],
    ].map(
      ([listener, port]) =>
        new Promise((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(port, config.bindHost, resolve);
        }),
    ),
  );
  log({
    event: "listening",
    registryId: store.registryId,
    origin: config.publicOrigin,
    api: config.apiPort,
    plugin: config.pluginPort,
    ask: config.askPort,
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`registry failed to start: ${error?.message ?? error}`);
    process.exit(1);
  });
}
