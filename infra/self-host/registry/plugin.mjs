// The frps server plugin (:8081). frps calls it for Login, NewProxy, Ping and NewWorkConn and has no
// timeout of its own, so the plugin answers within 1.5 s or rejects with t3x:busy. Every decision reads the
// live database; nothing is cached and nothing is written on this path.
// Spec: research/self-host-device-keys.md Q6, 3.7 and 3.12 D.
import * as NodeHttp from "node:http";

import {
  TICKET_TYP,
  ProofError,
  decodeJws,
  publicKeyFromJwk,
  verifyJwsSignature,
} from "./proof.mjs";

const { createServer } = NodeHttp;

export const PLUGIN_TIMEOUT_MS = 1500;
export const PLUGIN_MAX_IN_FLIGHT = 64;
export const PLUGIN_BODY_LIMIT_BYTES = 64 * 1024;
const TICKET_MAX_LENGTH = 2048;
/** The longest a ticket may live (`exp - iat`), and how far ahead of this clock its `iat` may be. */
export const TICKET_MAX_LIFETIME_SECONDS = 86_400;
export const TICKET_CLOCK_SKEW_SECONDS = 300;
const PROXY_NAME_SUFFIX = ".t3x";

/** Test seam: the end-to-end suite preloads a module that sets `beforeOp` to make an op slow. Never set in production. */
export const testHooks = { beforeOp: null };

const REASONS = {
  revoked: "t3x:revoked",
  expired: "t3x:ticket-expired",
  badTicket: "t3x:bad-ticket",
  busy: "t3x:busy",
};

const allow = { reject: false, unchange: true };
const reject = (reason) => ({ reject: true, reject_reason: reason });
const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

/** Steps 1-6 of the Login order, shared by all four ops. Returns `{device}` or `{verdict}` (a rejection). */
function checkTicket(store, ticket, user, now) {
  if (typeof ticket !== "string" || ticket.length > TICKET_MAX_LENGTH)
    return { verdict: reject(REASONS.badTicket) };
  let decoded;
  try {
    decoded = decodeJws(ticket, { maxLength: TICKET_MAX_LENGTH });
  } catch (error) {
    if (error instanceof ProofError) return { verdict: reject(REASONS.badTicket) };
    throw error;
  }
  const { header, payload } = decoded;
  if (header.alg !== "ES256" || header.typ !== TICKET_TYP || typeof header.kid !== "string") {
    return { verdict: reject(REASONS.badTicket) };
  }
  const device = store.getDevice(header.kid);
  if (device === null) return { verdict: reject(REASONS.revoked) };
  if (device.kind !== "computer") return { verdict: reject(REASONS.badTicket) };
  if (!verifyJwsSignature(decoded, publicKeyFromJwk(device.jwk)))
    return { verdict: reject(REASONS.badTicket) };
  if (
    payload.v !== 1 ||
    payload.iss !== device.id ||
    payload.rid !== store.registryId ||
    payload.sub !== device.subdomain ||
    payload.gen !== device.createdAt ||
    user !== device.id.slice(0, 16)
  ) {
    return { verdict: reject(REASONS.badTicket) };
  }
  // A ticket's lifetime is bounded by what the registry accepts, not by what the signer claims:
  // a device key must not be able to mint a ticket that outlives the 24 hours the design allows.
  if (!Number.isSafeInteger(payload.iat) || payload.iat > now + TICKET_CLOCK_SKEW_SECONDS) {
    return { verdict: reject(REASONS.badTicket) };
  }
  if (Number.isSafeInteger(payload.exp)) {
    if (payload.exp <= payload.iat || payload.exp - payload.iat > TICKET_MAX_LIFETIME_SECONDS) {
      return { verdict: reject(REASONS.badTicket) };
    }
  }
  if (!(Number.isSafeInteger(payload.exp) && payload.exp > now)) {
    return { verdict: reject(REASONS.expired) };
  }
  return { device };
}

/** Decides one plugin request. Synchronous: SQLite reads and one ECDSA verification. */
export function decide(store, request, now) {
  const content = request?.content;
  if (typeof content !== "object" || content === null) return reject(REASONS.badTicket);
  const op = request.op;

  if (op === "Login") {
    const result = checkTicket(store, content.metas?.t3x_ticket, content.user, now);
    if (result.verdict !== undefined) return result.verdict;
    store.touch(result.device.id, "tunnel", now);
    return allow;
  }
  if (op !== "NewProxy" && op !== "Ping" && op !== "NewWorkConn") return reject(REASONS.badTicket);

  // frps does not send a run_id with Login, so these ops re-verify the ticket frpc repeats in user.metas.
  const user = content.user;
  const result = checkTicket(store, user?.metas?.t3x_ticket, user?.user, now);
  if (result.verdict !== undefined) return result.verdict;
  const { device } = result;

  if (op === "NewProxy") {
    const valid =
      content.proxy_type === "http" &&
      content.proxy_name === `${user.user}${PROXY_NAME_SUFFIX}` &&
      content.subdomain === device.subdomain &&
      isEmpty(content.custom_domains) &&
      isEmpty(content.locations) &&
      isEmpty(content.http_user) &&
      isEmpty(content.route_by_http_user);
    if (!valid) return reject(REASONS.badTicket);
  } else {
    store.touch(device.id, "tunnel", now);
  }
  return allow;
}

function readBody(req, signal) {
  return new Promise((resolve, reject_) => {
    const chunks = [];
    let size = 0;
    const fail = () => reject_(new Error("unreadable"));
    signal.addEventListener("abort", fail, { once: true });
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > PLUGIN_BODY_LIMIT_BYTES) {
        fail();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

/**
 * @param {{store: import("./db.mjs").Store, now: () => number, log?: (entry: object) => void, timeoutMs?: number, maxInFlight?: number}} deps
 */
export function createPluginServer({
  store,
  now,
  log = () => {},
  timeoutMs = PLUGIN_TIMEOUT_MS,
  maxInFlight = PLUGIN_MAX_IN_FLIGHT,
}) {
  let inFlight = 0;
  const writeJson = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  return createServer(async (req, res) => {
    const path = (req.url ?? "").split("?", 1)[0];
    if (req.method === "GET" && path === "/health") {
      try {
        store.db.prepare("SELECT 1").get();
        writeJson(res, 200, { ok: true });
      } catch {
        writeJson(res, 503, { ok: false });
      }
      return;
    }
    if (req.method !== "POST" || path !== "/frps") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    if (inFlight >= maxInFlight) {
      writeJson(res, 503, { error: "busy" });
      return;
    }

    inFlight += 1;
    const started = performance.now();
    const abort = new AbortController();
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      inFlight -= 1;
      return true;
    };
    const timer = setTimeout(() => {
      abort.abort();
      if (finish()) {
        log({
          level: "warn",
          event: "plugin_timeout",
          ms: Math.round(performance.now() - started),
        });
        writeJson(res, 200, reject(REASONS.busy));
        res.once("finish", () => req.destroy());
      }
    }, timeoutMs);

    let verdict;
    let op = "?";
    try {
      const request = JSON.parse((await readBody(req, abort.signal)).toString("utf8"));
      op = typeof request?.op === "string" ? request.op : "?";
      if (testHooks.beforeOp !== null) await testHooks.beforeOp(op, request);
      verdict = decide(store, request, now());
    } catch (error) {
      if (settled) return;
      log({ level: "warn", event: "plugin_unreadable", message: String(error?.message ?? error) });
      verdict = reject(REASONS.badTicket);
    }
    if (finish()) {
      if (verdict.reject) log({ event: "plugin_rejected", op, reason: verdict.reject_reason });
      writeJson(res, 200, verdict);
    }
  });
}
