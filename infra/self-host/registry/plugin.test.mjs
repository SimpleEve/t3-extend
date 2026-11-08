// The frps plugin (Login, NewProxy, Ping, NewWorkConn) and Caddy's ask endpoint against research/self-host-device-keys.md 3.12 D.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { ASK_MAX_IN_FLIGHT, askHooks, createAskServer, subdomainOf } from "./ask.mjs";
import { Store } from "./db.mjs";
import { generateDeviceKey, signJws, signTicket } from "./proof.mjs";
import { PLUGIN_MAX_IN_FLIGHT, createPluginServer, decide, testHooks } from "./plugin.mjs";
import { createClock, rawRequest, testConfig } from "./testkit.mjs";

const assert = NodeAssert;
const { mkdtempSync, rmSync } = NodeFS;
const { connect } = NodeNet;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { afterEach, beforeEach, describe, it } = NodeTest;

const clock = createClock();
let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t3x-plugin-test-"));
  store = Store.open(join(dir, "registry.db"));
  testHooks.beforeOp = null;
});
afterEach(() => {
  testHooks.beforeOp = null;
  askHooks.before = null;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function enrollComputer(name = "Mac") {
  const key = generateDeviceKey();
  const invite = store.createInvite({ kind: "computer", createdBy: "cli", now: clock.now() });
  const { device } = store.join({
    inviteId: invite.id,
    secret: invite.secret,
    device: { ...key, name, kind: "computer" },
    now: clock.now(),
  });
  return { ...key, row: device };
}

const ticketFor = (computer, overrides = {}) =>
  signTicket({
    privateKey: computer.privateKey,
    kid: computer.id,
    rid: store.registryId,
    sub: computer.row.subdomain,
    gen: computer.row.createdAt,
    iat: clock.now(),
    ...overrides,
  });

const userOf = (computer, ticket = ticketFor(computer)) => ({
  user: computer.id.slice(0, 16),
  metas: { t3x_ticket: ticket },
  run_id: "abcdef0123456789",
});
// Arguments are passed through even when undefined, so a test can send "no ticket" or "no user".
const login = (computer, ...rest) => {
  const ticket = rest.length > 0 ? rest[0] : ticketFor(computer);
  const user = rest.length > 1 ? rest[1] : computer.id.slice(0, 16);
  return { op: "Login", content: { user, metas: { t3x_ticket: ticket } } };
};
const withUser = (op, computer, extra = {}, ticket) => ({
  op,
  content: { user: userOf(computer, ticket), ...extra },
});
const proxy = (computer, extra = {}, ticket) =>
  withUser(
    "NewProxy",
    computer,
    {
      proxy_name: `${computer.id.slice(0, 16)}.t3x`,
      proxy_type: "http",
      subdomain: computer.row.subdomain,
      ...extra,
    },
    ticket,
  );

const ALLOW = { reject: false, unchange: true };
const rejected = (reason) => ({ reject: true, reject_reason: `t3x:${reason}` });
const run = (request) => decide(store, request, clock.now());

describe("Login: the seven steps in order", () => {
  it("lets a valid ticket in and records the tunnel in memory", () => {
    const mac = enrollComputer();
    assert.deepEqual(run(login(mac)), ALLOW);
    assert.equal(store.withTouches(store.getDevice(mac.id)).lastTunnelAt, clock.now());
    assert.equal(store.getDevice(mac.id).lastTunnelAt, null);
  });

  it("1. rejects tickets that are missing, too long, undecodable or the wrong type", () => {
    const mac = enrollComputer();
    const good = ticketFor(mac);
    const [header, payload, signature] = good.split(".");
    const wrongTyp = signJws({ alg: "ES256", typ: "JWT", kid: mac.id }, {}, mac.privateKey);
    const noKid = signJws({ alg: "ES256", typ: "t3x-ticket+jwt" }, {}, mac.privateKey);
    const wrongAlg = signJws(
      { alg: "none", typ: "t3x-ticket+jwt", kid: mac.id },
      {},
      mac.privateKey,
    );
    for (const ticket of [
      undefined,
      7,
      "",
      "x".repeat(2049),
      "a.b.c",
      `${header}.${payload}`,
      wrongTyp,
      noKid,
      wrongAlg,
      `${header}.${payload}.${signature}x`,
    ]) {
      assert.deepEqual(
        run(login(mac, ticket)),
        rejected("bad-ticket"),
        String(ticket).slice(0, 30),
      );
    }
  });

  it("2. reports revoked when the device row is gone, whatever else is wrong", () => {
    const mac = enrollComputer();
    const ticket = ticketFor(mac);
    store.removeDevice(mac.id, clock.now());
    assert.deepEqual(run(login(mac, ticket)), rejected("revoked"));
    assert.deepEqual(
      run(login(mac, ticketFor(mac, { exp: clock.now() - 1 }))),
      rejected("revoked"),
    );
    const stranger = generateDeviceKey();
    const unknown = signJws(
      { alg: "ES256", typ: "t3x-ticket+jwt", kid: stranger.id },
      {},
      stranger.privateKey,
    );
    assert.deepEqual(run(login(mac, unknown)), rejected("revoked"));
  });

  it("3. rejects a phone's ticket", () => {
    const key = generateDeviceKey();
    const invite = store.createInvite({ kind: "phone", createdBy: "cli", now: clock.now() });
    store.join({
      inviteId: invite.id,
      secret: invite.secret,
      device: { ...key, name: "Pixel", kind: "phone" },
      now: clock.now(),
    });
    const ticket = signTicket({
      privateKey: key.privateKey,
      kid: key.id,
      rid: store.registryId,
      sub: "pixel",
      gen: clock.now(),
      iat: clock.now(),
    });
    assert.deepEqual(
      run({ op: "Login", content: { user: key.id.slice(0, 16), metas: { t3x_ticket: ticket } } }),
      rejected("bad-ticket"),
    );
  });

  it("4. rejects a ticket signed by a different key, even for a real device id", () => {
    const mac = enrollComputer();
    const attacker = generateDeviceKey();
    const forged = signTicket({
      privateKey: attacker.privateKey,
      kid: mac.id,
      rid: store.registryId,
      sub: mac.row.subdomain,
      gen: mac.row.createdAt,
      iat: clock.now(),
    });
    assert.deepEqual(run(login(mac, forged)), rejected("bad-ticket"));
  });

  it("5. rejects a wrong registry, subdomain, generation, issuer or user", () => {
    const mac = enrollComputer();
    const other = enrollComputer("Other");
    const cases = {
      "other registry": ticketFor(mac, { rid: "zzzzzzzz" }),
      "other subdomain": ticketFor(mac, { sub: other.row.subdomain }),
      "other generation": ticketFor(mac, { gen: mac.row.createdAt - 1 }),
      "other issuer": signJws(
        { alg: "ES256", typ: "t3x-ticket+jwt", kid: mac.id },
        {
          v: 1,
          iss: other.id,
          rid: store.registryId,
          sub: mac.row.subdomain,
          gen: mac.row.createdAt,
          iat: clock.now(),
          exp: clock.now() + 60,
        },
        mac.privateKey,
      ),
      "other version": signJws(
        { alg: "ES256", typ: "t3x-ticket+jwt", kid: mac.id },
        {
          v: 2,
          iss: mac.id,
          rid: store.registryId,
          sub: mac.row.subdomain,
          gen: mac.row.createdAt,
          iat: clock.now(),
          exp: clock.now() + 60,
        },
        mac.privateKey,
      ),
    };
    for (const [label, ticket] of Object.entries(cases))
      assert.deepEqual(run(login(mac, ticket)), rejected("bad-ticket"), label);
    assert.deepEqual(
      run(login(mac, ticketFor(mac), other.id.slice(0, 16))),
      rejected("bad-ticket"),
    );
    assert.deepEqual(run(login(mac, ticketFor(mac), undefined)), rejected("bad-ticket"));
  });

  it("6. rejects an expired ticket only after everything else checked out", () => {
    const mac = enrollComputer();
    // `iat` is set before `exp` so the ticket's own shape is sound and only its age is wrong.
    assert.deepEqual(
      run(login(mac, ticketFor(mac, { iat: clock.now() - 60, exp: clock.now() }))),
      rejected("ticket-expired"),
    );
    assert.deepEqual(
      run(login(mac, ticketFor(mac, { iat: clock.now() - 7200, exp: clock.now() - 3600 }))),
      rejected("ticket-expired"),
    );
    assert.deepEqual(run(login(mac, ticketFor(mac, { exp: clock.now() + 1 }))), ALLOW);
    assert.deepEqual(run(login(mac, ticketFor(mac, { exp: "soon" }))), rejected("ticket-expired"));
    // Wrong subdomain and expired: the earlier check wins.
    assert.deepEqual(
      run(login(mac, ticketFor(mac, { exp: clock.now() - 1, sub: "elsewhere" }))),
      rejected("bad-ticket"),
    );
  });

  it("6b. rejects a ticket whose own lifetime is out of bounds, on all four ops", () => {
    const mac = enrollComputer();
    const now = clock.now();
    const cases = {
      "exp equals iat": { iat: now, exp: now },
      "exp before iat": { iat: now, exp: now - 10 },
      "exactly one second past 24 hours": { iat: now, exp: now + 86_401 },
      "a century": { iat: now, exp: now + 100 * 365 * 86_400 },
      "iat more than 5 minutes ahead": { iat: now + 301, exp: now + 601 },
      "iat missing": { iat: undefined, exp: now + 60 },
      "iat fractional": { iat: now + 0.5, exp: now + 60 },
      "iat a string": { iat: "now", exp: now + 60 },
    };
    for (const [label, fields] of Object.entries(cases)) {
      const ticket = ticketFor(mac, fields);
      for (const request of [
        login(mac, ticket),
        withUser("Ping", mac, {}, ticket),
        withUser("NewWorkConn", mac, {}, ticket),
        proxy(mac, {}, ticket),
      ]) {
        assert.deepEqual(run(request), rejected("bad-ticket"), `${label} / ${request.op}`);
      }
    }
    // The boundaries themselves are fine: exactly 24 hours, and exactly 5 minutes of skew.
    assert.deepEqual(run(login(mac, ticketFor(mac, { iat: now, exp: now + 86_400 }))), ALLOW);
    assert.deepEqual(run(login(mac, ticketFor(mac, { iat: now + 300, exp: now + 400 }))), ALLOW);
  });

  it("7. a database error rejects (here: the table is gone)", () => {
    const mac = enrollComputer();
    store.db.exec("DROP TABLE devices");
    assert.throws(() => run(login(mac)));
  });

  it("rejects a reused removed computer's ticket after the same key re-joins with a new subdomain", () => {
    const mac = enrollComputer("Mac");
    const oldTicket = ticketFor(mac);
    store.removeDevice(mac.id, clock.now());
    const invite = store.createInvite({ kind: "computer", createdBy: "cli", now: clock.now() });
    const { device } = store.join({
      inviteId: invite.id,
      secret: invite.secret,
      device: { id: mac.id, jwk: mac.jwk, name: "Mac", kind: "computer" },
      now: clock.now(),
    });
    assert.equal(device.subdomain, "mac-2");
    assert.deepEqual(run(login(mac, oldTicket)), rejected("bad-ticket"));
  });
});

describe("the other ops read the live database every time", () => {
  it("Ping, NewWorkConn and NewProxy pass for a logged-in device and update the tunnel clock", () => {
    const mac = enrollComputer();
    assert.deepEqual(run(login(mac)), ALLOW);
    clock.advance(30);
    assert.deepEqual(run(withUser("Ping", mac)), ALLOW);
    assert.equal(store.withTouches(store.getDevice(mac.id)).lastTunnelAt, clock.now());
    assert.deepEqual(run(withUser("NewWorkConn", mac, { run_id: "abcdef0123456789" })), ALLOW);
    assert.deepEqual(run(proxy(mac)), ALLOW);
  });

  it("removing the device makes the next Ping, the next Login and the next NewWorkConn fail", () => {
    const mac = enrollComputer();
    const ticket = ticketFor(mac);
    assert.deepEqual(run(login(mac, ticket)), ALLOW);
    assert.deepEqual(run(withUser("Ping", mac, {}, ticket)), ALLOW);
    store.removeDevice(mac.id, clock.now());
    assert.deepEqual(run(withUser("Ping", mac, {}, ticket)), rejected("revoked"));
    assert.deepEqual(run(login(mac, ticket)), rejected("revoked"));
    assert.deepEqual(run(withUser("NewWorkConn", mac, {}, ticket)), rejected("revoked"));
    assert.deepEqual(run(proxy(mac, {}, ticket)), rejected("revoked"));
  });

  it("a re-registered device (new generation) can no longer use the old ticket", () => {
    const mac = enrollComputer();
    const ticket = ticketFor(mac);
    store.db.prepare("UPDATE devices SET created_at = created_at + 1 WHERE id = ?").run(mac.id);
    for (const op of ["Ping", "NewWorkConn", "NewProxy"]) {
      assert.deepEqual(
        run({
          op,
          content: {
            ...(op === "NewProxy" ? proxy(mac, {}, ticket).content : { user: userOf(mac, ticket) }),
          },
        }),
        rejected("bad-ticket"),
        op,
      );
    }
  });

  it("rejects an expired ticket on every op, so a stolen ticket cannot hold a tunnel past its expiry", () => {
    const mac = enrollComputer();
    const ticket = ticketFor(mac, { exp: clock.now() + 10 });
    assert.deepEqual(run(withUser("Ping", mac, {}, ticket)), ALLOW);
    clock.advance(11);
    assert.deepEqual(run(login(mac, ticket)), rejected("ticket-expired"));
    assert.deepEqual(run(withUser("Ping", mac, {}, ticket)), rejected("ticket-expired"));
    assert.deepEqual(run(withUser("NewWorkConn", mac, {}, ticket)), rejected("ticket-expired"));
    assert.deepEqual(run(proxy(mac, {}, ticket)), rejected("ticket-expired"));
    // A freshly signed ticket (the 12-hour rotation) is accepted by all of them again.
    const fresh = ticketFor(mac);
    assert.deepEqual(run(withUser("Ping", mac, {}, fresh)), ALLOW);
  });

  it("rejects a user that is not this device's id prefix, a missing ticket and unknown ops", () => {
    const mac = enrollComputer();
    const other = enrollComputer("Other");
    const swapped = {
      op: "Ping",
      content: {
        user: { user: other.id.slice(0, 16), metas: { t3x_ticket: ticketFor(mac) }, run_id: "r" },
      },
    };
    assert.deepEqual(run(swapped), rejected("bad-ticket"));
    assert.deepEqual(
      run({ op: "Ping", content: { user: { user: mac.id.slice(0, 16), run_id: "r" } } }),
      rejected("bad-ticket"),
    );
    assert.deepEqual(run({ op: "CloseProxy", content: {} }), rejected("bad-ticket"));
    assert.deepEqual(run({ op: "Ping" }), rejected("bad-ticket"));
    assert.deepEqual(run(null), rejected("bad-ticket"));
  });
});

describe("NewProxy constraints", () => {
  it("accepts only the device's own http proxy on its own subdomain", () => {
    const mac = enrollComputer();
    const other = enrollComputer("Other");
    const bad = {
      "tcp proxy": { proxy_type: "tcp" },
      "https proxy": { proxy_type: "https" },
      "another subdomain": { subdomain: other.row.subdomain },
      "no subdomain": { subdomain: "" },
      "another proxy name": { proxy_name: `${mac.id.slice(0, 16)}.second` },
      "someone else's proxy name": { proxy_name: `${other.id.slice(0, 16)}.t3x` },
      "custom domain": { custom_domains: ["evil.example"] },
      locations: { locations: ["/x"] },
      "http user": { http_user: "bob" },
      "route by http user": { route_by_http_user: "bob" },
    };
    for (const [label, extra] of Object.entries(bad))
      assert.deepEqual(run(proxy(mac, extra)), rejected("bad-ticket"), label);
    assert.deepEqual(
      run(proxy(mac, { custom_domains: [], locations: [], http_user: "", route_by_http_user: "" })),
      ALLOW,
    );
    assert.deepEqual(run(proxy(mac, { custom_domains: null })), ALLOW);
  });

  it("computer A cannot register computer B's subdomain even with a valid ticket of its own", () => {
    const a = enrollComputer("A");
    const b = enrollComputer("B");
    assert.deepEqual(run(proxy(a, { subdomain: b.row.subdomain })), rejected("bad-ticket"));
  });
});

describe("the HTTP listener", () => {
  let server;
  let port;
  const start = async (options = {}) => {
    server = createPluginServer({ store, now: clock.now, log: options.log, ...options });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  };
  afterEach(async () => {
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  });
  const post = (body, path = "/frps?op=Login&version=0.1.0") =>
    rawRequest({
      port,
      method: "POST",
      path,
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("answers the frps wire format", async () => {
    await start();
    const mac = enrollComputer();
    const allowed = await post({ version: "0.1.0", ...login(mac) });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.json, ALLOW);
    const refused = await post({ version: "0.1.0", ...login(mac, "nope") });
    assert.equal(refused.status, 200);
    assert.deepEqual(refused.json, rejected("bad-ticket"));
  });

  it("treats an unreadable, oversized or non-object body as a rejection", async () => {
    await start();
    for (const body of [
      "{",
      "[]",
      "null",
      JSON.stringify({ op: "Login", content: { pad: "x".repeat(70_000) } }),
    ]) {
      assert.deepEqual((await post(body)).json, rejected("bad-ticket"), body.slice(0, 20));
    }
  });

  it("serves /health with a SELECT 1 and 404s everything else", async () => {
    await start();
    assert.equal((await rawRequest({ port, path: "/health" })).status, 200);
    assert.equal((await rawRequest({ port, path: "/frps" })).status, 404);
    assert.equal(
      (await rawRequest({ port, method: "POST", path: "/other", body: "{}" })).status,
      404,
    );
    store.db.exec("PRAGMA query_only = ON");
    assert.equal((await rawRequest({ port, path: "/health" })).status, 200);
    store.close();
    assert.equal((await rawRequest({ port, path: "/health" })).status, 503);
    store = Store.open(join(dir, "registry.db"));
  });

  it("answers t3x:busy at the time limit when a handler is slow, and discards the late result", async () => {
    const logs = [];
    await start({ timeoutMs: 80, log: (entry) => logs.push(entry) });
    const mac = enrollComputer();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    testHooks.beforeOp = async (op) => {
      if (op === "Login") await gate;
    };
    const slow = await post(login(mac));
    assert.deepEqual(slow.json, rejected("busy"));
    assert.ok(logs.some((entry) => entry.event === "plugin_timeout"));
    release();
    // Other ops are not blocked by the stuck Login.
    assert.deepEqual((await post(withUser("Ping", mac))).json, ALLOW);
  });

  it("times out a request body that never finishes", async () => {
    await start({ timeoutMs: 80 });
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    const reply = new Promise((resolve) =>
      socket.once("data", (chunk) => resolve(chunk.toString())),
    );
    socket.write(
      "POST /frps?op=Login HTTP/1.1\r\nhost: x\r\ncontent-length: 500\r\ncontent-type: application/json\r\n\r\n{",
    );
    const text = await reply;
    assert.match(text, /^HTTP\/1\.1 200/);
    assert.match(text, /t3x:busy/);
    socket.destroy();
  });

  it("shares 64 in-flight slots across all four ops and answers 503 busy for the 65th, immediately", async () => {
    await start({ timeoutMs: 5000 });
    const mac = enrollComputer();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let holding = 0;
    let allHeld;
    const everyoneHeld = new Promise((resolve) => {
      allHeld = resolve;
    });
    testHooks.beforeOp = async () => {
      holding += 1;
      if (holding === PLUGIN_MAX_IN_FLIGHT) allHeld();
      await gate;
    };
    const ops = ["Login", "NewProxy", "Ping", "NewWorkConn"];
    const pending = Array.from({ length: PLUGIN_MAX_IN_FLIGHT }, (_, i) => {
      const op = ops[i % 4];
      const body = op === "Login" ? login(mac) : op === "NewProxy" ? proxy(mac) : withUser(op, mac);
      return post(body);
    });
    await everyoneHeld;
    const overflow = await post(withUser("Ping", mac));
    assert.equal(overflow.status, 503);
    assert.deepEqual(overflow.json, { error: "busy" });
    release();
    const settled = await Promise.all(pending);
    assert.ok(settled.every((r) => r.status === 200 && r.json.reject === false));
    assert.equal((await post(withUser("Ping", mac))).status, 200);
  });
});

describe("ask", () => {
  const config = testConfig({ domain: "t3.example.com" });
  let server;
  let port;
  const start = async (options = {}) => {
    server = createAskServer({ store, config, ...options });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  };
  afterEach(async () => {
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  });
  const ask = (domain) => rawRequest({ port, path: `/ask?domain=${encodeURIComponent(domain)}` });

  it("also allows ntfy.<domain> when the push server is installed, and no other reserved name", async () => {
    config.ntfyInstalled = true;
    try {
      await start();
      assert.equal((await ask("ntfy.t3.example.com")).status, 200);
      assert.equal((await ask("NTFY.T3.EXAMPLE.COM")).status, 200);
      for (const domain of ["www.t3.example.com", "a.ntfy.t3.example.com", "ntfy.example.com"])
        assert.equal((await ask(domain)).status, 403, domain);
    } finally {
      config.ntfyInstalled = false;
    }
  });

  it("allows exactly <registered subdomain>.<domain>", async () => {
    await start();
    enrollComputer("Mac");
    for (const domain of ["mac.t3.example.com", "MAC.T3.EXAMPLE.COM"])
      assert.equal((await ask(domain)).status, 200, domain);
    for (const domain of [
      "other.t3.example.com",
      "t3.example.com",
      "ntfy.t3.example.com",
      "a.mac.t3.example.com",
      "mac.t3.example.com.evil.test",
      "mac.example.com",
      "",
      "-.t3.example.com",
      ".t3.example.com",
      "mac..t3.example.com",
    ]) {
      assert.equal((await ask(domain)).status, 403, domain);
    }
    assert.equal((await rawRequest({ port, path: "/ask" })).status, 403);
    assert.equal(
      (await rawRequest({ port, path: "/elsewhere?domain=mac.t3.example.com" })).status,
      403,
    );
    assert.equal(
      (await rawRequest({ port, method: "POST", path: "/ask?domain=mac.t3.example.com" })).status,
      403,
    );
  });

  it("refuses a removed computer's subdomain at once, with no cache", async () => {
    await start();
    const mac = enrollComputer("Mac");
    assert.equal((await ask("mac.t3.example.com")).status, 200);
    store.removeDevice(mac.id, clock.now());
    assert.equal((await ask("mac.t3.example.com")).status, 403);
    // Tombstoned, not assignable: still refused after a new computer asks for the same name.
    assert.equal(enrollComputer("Mac").row.subdomain, "mac-2");
    assert.equal((await ask("mac.t3.example.com")).status, 403);
    assert.equal((await ask("mac-2.t3.example.com")).status, 200);
  });

  it("answers 503 when the database fails", async () => {
    await start();
    store.db.exec("DROP TABLE devices");
    assert.equal((await ask("mac.t3.example.com")).status, 503);
  });

  it("answers 503 for the 33rd question in flight, independently of the plugin's 64", async () => {
    assert.equal(ASK_MAX_IN_FLIGHT, 32);
    await start();
    enrollComputer("Mac");
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let holding = 0;
    let allHeld;
    const everyoneHeld = new Promise((resolve) => {
      allHeld = resolve;
    });
    askHooks.before = () => {
      holding += 1;
      if (holding === ASK_MAX_IN_FLIGHT) allHeld();
      return gate;
    };
    const held = Array.from({ length: ASK_MAX_IN_FLIGHT }, () => ask("mac.t3.example.com"));
    await everyoneHeld;
    askHooks.before = null;
    const overflow = await ask("mac.t3.example.com");
    assert.equal(overflow.status, 503);
    release();
    askHooks.before = null;
    await Promise.all(held);
    assert.equal((await ask("mac.t3.example.com")).status, 200);
  });

  it("extracts the label with IDNA lowercase and rejects anything with more than one", () => {
    assert.equal(subdomainOf("Mac.T3.Example.com", "t3.example.com"), "mac");
    assert.equal(subdomainOf("mac-2.t3.example.com", "t3.example.com"), "mac-2");
    assert.equal(subdomainOf("a.b.t3.example.com", "t3.example.com"), null);
    assert.equal(subdomainOf("t3.example.com", "t3.example.com"), null);
  });
});
