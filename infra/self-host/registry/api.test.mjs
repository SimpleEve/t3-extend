// The /v1 API against the frozen contract (research/self-host-device-keys.md 3.12 A and B).
import * as NodeAssert from "node:assert/strict";
import * as NodeNet from "node:net";
import * as NodeTest from "node:test";

import { MAX_OPEN_INVITES } from "./db.mjs";
import { decodeInvite } from "./invites.mjs";
import { signRequestProof } from "./proof.mjs";
import { MAX_IN_FLIGHT, deviceUrl, loadConfig, normalizeHostForLog } from "./server.mjs";
import {
  FakeDevice,
  cliInvite,
  enroll,
  rawRequest,
  startTestRegistry,
  testConfig,
} from "./testkit.mjs";

const assert = NodeAssert;
const { connect } = NodeNet;
const { afterEach, beforeEach, describe, it } = NodeTest;

let reg;
beforeEach(async () => {
  reg = await startTestRegistry();
});
afterEach(async () => {
  await reg.close();
});

function expectError(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.deepEqual(Object.keys(response.json).sort(), ["error", "error_description"]);
  assert.equal(response.json.error, code);
  assert.equal(typeof response.json.error_description, "string");
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.equal(response.headers["cache-control"], "no-store");
  return response;
}

const get = (port, path, headers = {}) =>
  rawRequest({ port, path, headers: { "x-t3x-client-ip": "198.51.100.1", ...headers } });

describe("GET /v1/info", () => {
  it("is public and reports the registry", async () => {
    const response = await get(reg.port, "/v1/info");
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      apiVersion: 1,
      registryId: reg.store.registryId,
      domain: "registry.test",
      publicPort: 443,
    });
    assert.equal(response.headers["cache-control"], "no-store");
  });
});

describe("POST /v1/join", () => {
  it("registers a computer with a subdomain and a phone without one", async () => {
    const mac = new FakeDevice(reg, { name: "Mac" });
    const joined = await mac.join(await cliInvite(reg, "computer"));
    assert.equal(joined.status, 201, joined.text);
    assert.deepEqual(joined.json, {
      registryId: reg.store.registryId,
      deviceId: mac.id,
      name: "Mac",
      subdomain: "mac",
      url: "https://mac.registry.test",
      rev: reg.store.rev,
    });
    const phone = new FakeDevice(reg, { name: "Pixel", kind: "phone" });
    const phoneJoined = await phone.join(await cliInvite(reg, "phone"), { environmentId: "env_1" });
    assert.equal(phoneJoined.status, 201);
    assert.deepEqual(Object.keys(phoneJoined.json).sort(), [
      "deviceId",
      "name",
      "registryId",
      "rev",
    ]);
  });

  it("uses the port in device URLs when the public port is not 443", () => {
    assert.equal(
      deviceUrl(testConfig({ domain: "t3.localhost", publicPort: 18443 }), "a"),
      "https://a.t3.localhost:18443",
    );
  });

  it("answers every failed redemption with the contract's status and code", async () => {
    const send = (device, invite, overrides) =>
      device.send("POST", "/v1/join", {
        auth: "jwk",
        json: {
          invite,
          device: { name: device.name, kind: device.kind, jwk: device.jwk },
          ...overrides,
        },
      });
    const redemption = async (kind = "any") => {
      const decoded = decodeInvite(await cliInvite(reg, kind));
      return `${decoded.id}.${decoded.secret}`;
    };

    const unknown = await send(new FakeDevice(reg), "AAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA");
    expectError(unknown, 400, "invite_invalid");
    const real = await redemption();
    const wrongSecret = await send(
      new FakeDevice(reg),
      `${real.split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAA`,
    );
    expectError(wrongSecret, 400, "invite_invalid");
    // A missing invite and a wrong secret cannot be told apart.
    assert.equal(wrongSecret.text, unknown.text);
    expectError(await send(new FakeDevice(reg), "not-an-invite"), 400, "invite_invalid");

    expectError(await send(new FakeDevice(reg, { name: "   " }), real), 400, "name_invalid");
    expectError(
      await send(new FakeDevice(reg, { name: "x".repeat(41) }), real),
      400,
      "name_invalid",
    );
    expectError(
      await send(new FakeDevice(reg, { name: "bad\u0007name" }), real),
      400,
      "name_invalid",
    );

    const winner = new FakeDevice(reg, { name: "Winner" });
    assert.equal((await send(winner, real)).status, 201);
    expectError(await send(new FakeDevice(reg, { name: "Late" }), real), 409, "invite_used");

    const phoneOnly = await redemption("phone");
    expectError(
      await send(new FakeDevice(reg, { name: "Laptop" }), phoneOnly),
      409,
      "kind_mismatch",
    );

    const stale = await redemption();
    reg.clock.advance(15 * 60);
    expectError(await send(new FakeDevice(reg, { name: "Slow" }), stale), 410, "invite_expired");
  });

  it("rejects malformed bodies with invalid_request", async () => {
    const stranger = new FakeDevice(reg, { name: "Stranger" });
    const good = {
      invite: "AAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA",
      device: { name: "x", kind: "computer", jwk: stranger.jwk },
    };
    const bodies = [
      Buffer.from("{not json"),
      Buffer.from("[]"),
      Buffer.from(JSON.stringify({ ...good, extra: 1 })),
      Buffer.from(JSON.stringify({ invite: good.invite })),
      Buffer.from(JSON.stringify({ ...good, invite: 7 })),
      Buffer.from(JSON.stringify({ ...good, device: { ...good.device, extra: 1 } })),
      Buffer.from(JSON.stringify({ ...good, device: { ...good.device, kind: "watch" } })),
      Buffer.from(
        JSON.stringify({ ...good, device: { ...good.device, jwk: { ...stranger.jwk, d: "x" } } }),
      ),
      Buffer.from(
        JSON.stringify({ ...good, device: { ...good.device, environmentId: "has space" } }),
      ),
      Buffer.from(JSON.stringify({ ...good, device: { name: "x", kind: "computer" } })),
    ];
    for (const rawBody of bodies) {
      expectError(
        await stranger.send("POST", "/v1/join", { auth: "jwk", rawBody }),
        400,
        "invalid_request",
      );
    }
  });

  it("rejects a join whose proof does not belong to the key in the body", async () => {
    const real = new FakeDevice(reg, { name: "Real" });
    const impostor = new FakeDevice(reg, { name: "Impostor" });
    const invite = decodeInvite(await cliInvite(reg));
    const response = await impostor.send("POST", "/v1/join", {
      auth: "jwk",
      json: {
        invite: `${invite.id}.${invite.secret}`,
        device: { name: "Real", kind: "computer", jwk: real.jwk },
      },
    });
    expectError(response, 401, "invalid_proof");
    assert.equal(reg.store.listDevices().length, 0);
  });

  it("refuses to register a key that is already registered, without using up the invite", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const invite = decodeInvite(await cliInvite(reg));
    const again = await mac.send("POST", "/v1/join", {
      auth: "jwk",
      json: {
        invite: `${invite.id}.${invite.secret}`,
        device: { name: "Mac again", kind: "computer", jwk: mac.jwk },
      },
    });
    expectError(again, 409, "device_exists");
    assert.equal(reg.store.listOpenInvites(reg.clock.now()).length, 1);
  });

  it("lets only one of two simultaneous requests redeem an invite", async () => {
    const invite = await cliInvite(reg);
    const results = await Promise.all([
      new FakeDevice(reg, { name: "One" }).join(invite),
      new FakeDevice(reg, { name: "Two" }).join(invite),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409).json.error, "invite_used");
  });
});

describe("signed requests: canonicalisation", () => {
  it("accepts a good request and ignores Host and forwarding headers", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const plain = await mac.send("GET", "/v1/devices");
    assert.equal(plain.status, 200);
    for (const headers of [
      { host: "evil.example" },
      { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
      {
        "x-forwarded-host": "a.example, b.example",
        "x-forwarded-proto": "http, https",
        forwarded: "host=evil.example;proto=http",
      },
      { host: "registry.test:8443" },
    ]) {
      assert.equal(
        (await mac.send("GET", "/v1/devices", { headers })).status,
        200,
        JSON.stringify(headers),
      );
    }
  });

  it("rejects a proof made for another origin, method, path or body", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const body = { kind: "phone" };
    const cases = {
      "other origin": mac.send("GET", "/v1/devices", {
        proof: { htu: "https://evil.example/v1/devices" },
      }),
      "same origin over http": mac.send("GET", "/v1/devices", {
        proof: { htu: "http://registry.test/v1/devices" },
      }),
      "other path": mac.send("GET", "/v1/devices", { signedPath: "/v1/invites" }),
      "other method": mac.send("POST", "/v1/invites", { json: body, proof: { method: "GET" } }),
      "query signed but not sent": mac.send("GET", "/v1/devices", {
        signedPath: "/v1/devices?x=1",
      }),
      "body altered": mac.send("POST", "/v1/invites", {
        json: body,
        signBody: Buffer.from('{"kind":"computer"}'),
      }),
      "body added after signing": mac.send("POST", "/v1/invites", {
        json: body,
        signBody: Buffer.alloc(0),
      }),
      "body removed after signing": mac.send("GET", "/v1/devices", { signBody: Buffer.from("{}") }),
    };
    for (const [label, pending] of Object.entries(cases)) {
      const response = await pending;
      assert.ok(
        response.status === 401 || response.status === 400,
        `${label}: ${response.status} ${response.text}`,
      );
      assert.ok(["invalid_proof", "invalid_request"].includes(response.json.error), label);
    }
    expectError(
      await mac.send("GET", "/v1/devices", { proof: { htu: "https://evil.example/v1/devices" } }),
      401,
      "invalid_proof",
    );
  });

  describe("Content-Length against the body that arrives", () => {
    const wire = (lines, body = "") => Buffer.from(`${lines.join("\r\n")}\r\n\r\n${body}`);
    const postHead = (extra) => [
      "POST /v1/join HTTP/1.1",
      "host: registry.test",
      "x-t3x-client-ip: 198.51.100.9",
      "content-type: application/json",
      ...extra,
    ];
    /** Sends the bytes, optionally half-closes, and resolves with everything the server says before it closes. */
    const exchange = (chunks, { halfClose = false } = {}) =>
      new Promise((resolve) => {
        const socket = connect(reg.port, "127.0.0.1");
        const received = [];
        socket.on("data", (chunk) => received.push(chunk));
        socket.on("error", () => {});
        socket.on("close", () => resolve(Buffer.concat(received).toString("utf8")));
        for (const chunk of chunks) socket.write(chunk);
        if (halfClose) socket.end();
      });
    const signedJoin = async () => {
      const stranger = new FakeDevice(reg, { name: "Stranger" });
      const invite = decodeInvite(await cliInvite(reg));
      const body = Buffer.from(
        JSON.stringify({
          invite: `${invite.id}.${invite.secret}`,
          device: { name: "Stranger", kind: "computer", jwk: stranger.jwk },
        }),
      );
      const proof = signRequestProof({
        privateKey: stranger.privateKey,
        jwk: stranger.jwk,
        method: "POST",
        htu: `${reg.config.publicOrigin}/v1/join`,
        body,
        iat: reg.clock.now(),
      });
      return { body, proof };
    };
    const stillWorks = async () => assert.equal((await get(reg.port, "/v1/info")).status, 200);

    it("refuses a body that ends before the declared length and leaves the invite alone", async () => {
      const { proof } = await signedJoin();
      const reply = await exchange(
        [wire(postHead(["content-length: 50", `t3x-proof: ${proof}`]), "0123456789")],
        { halfClose: true },
      );
      // The client has already half-closed, so the 400 may not be deliverable; what matters is that nothing ran.
      if (reply !== "") assert.match(reply, /^HTTP\/1\.1 400 /);
      assert.equal(reg.store.listOpenInvites(reg.clock.now()).length, 1);
      assert.equal(reg.store.listDevices().length, 0);
      await stillWorks();
    });

    it("answers a declared length over the limit with 400 and Connection: close, without reading the body", async () => {
      const reply = await exchange([wire(postHead(["content-length: 100000"]), "x".repeat(8000))]);
      assert.match(reply, /^HTTP\/1\.1 400 /);
      assert.match(reply, /connection: close/i);
      assert.match(reply, /"error":"invalid_request"/);
      await stillWorks();
    });

    it("treats a missing Content-Length as no body, so a chunked body is refused", async () => {
      const { body, proof } = await signedJoin();
      const reply = await exchange([
        wire(
          postHead(["transfer-encoding: chunked", `t3x-proof: ${proof}`]),
          `${body.length.toString(16)}\r\n${body.toString()}\r\n0\r\n\r\n`,
        ),
      ]);
      assert.match(reply, /^HTTP\/1\.1 400 /);
      assert.match(reply, /"error":"invalid_request"/);
      assert.equal(reg.store.listOpenInvites(reg.clock.now()).length, 1);
      assert.equal(reg.store.listDevices().length, 0);
    });

    it("still accepts the same request with its Content-Length", async () => {
      const { body, proof } = await signedJoin();
      const reply = await exchange([
        wire(
          postHead([`content-length: ${body.length}`, `t3x-proof: ${proof}`, "connection: close"]),
          body.toString(),
        ),
      ]);
      assert.match(reply, /^HTTP\/1\.1 201 /);
    });
  });

  it("refuses any query string before looking at the signature", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    expectError(
      await mac.send("GET", "/v1/devices?x=1", { signedPath: "/v1/devices?x=1" }),
      400,
      "invalid_request",
    );
    expectError(await get(reg.port, "/v1/info?"), 400, "invalid_request");
    expectError(await get(reg.port, "/v1/nope?x"), 400, "invalid_request");
  });

  it("answers 404 for paths that are not byte-for-byte a route", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    for (const path of [
      "/v1/devices/",
      "/v1//devices",
      "/v1/%64evices",
      "/v1/devices/%2e%2e",
      "/v1/../v1/devices",
      "/v1/devices/..",
      "/V1/devices",
      "/v1",
      "/",
      "/v1/devices%2F",
      "/v1/%C3%A9",
      "/v1/invites/short",
      `/v1/devices/${"A".repeat(44)}`,
    ]) {
      expectError(await mac.send("GET", path, { signedPath: path }), 404, "not_found");
    }
  });

  it("answers 405 with Allow when the path exists under another method", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const put = await mac.send("PUT", "/v1/devices");
    expectError(put, 405, "method_not_allowed");
    assert.equal(put.headers.allow, "GET");
    expectError(await mac.send("DELETE", "/v1/info"), 405, "method_not_allowed");
    expectError(await mac.send("DELETE", "/v1/devices/self"), 405, "method_not_allowed");
  });

  it("requires JSON content type, no content encoding and a body of at most 4 KB", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const body = Buffer.from('{"kind":"phone"}');
    expectError(
      await mac.send("POST", "/v1/invites", {
        rawBody: body,
        headers: { "content-type": "text/plain" },
      }),
      400,
      "invalid_request",
    );
    expectError(
      await mac.send("POST", "/v1/invites", {
        rawBody: body,
        headers: { "content-encoding": "gzip" },
      }),
      400,
      "invalid_request",
    );
    expectError(
      await mac.send("POST", "/v1/invites", { rawBody: Buffer.alloc(4097, 0x20) }),
      400,
      "invalid_request",
    );
    assert.equal(
      (
        await mac.send("POST", "/v1/invites", {
          rawBody: body,
          headers: { "content-type": "application/json; charset=utf-8" },
        })
      ).status,
      201,
    );
  });

  it("answers proofs that are malformed, replayed, stale or from an unknown device", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    expectError(
      await mac.send("GET", "/v1/devices", { headers: { "t3x-proof": "nonsense" } }),
      401,
      "invalid_proof",
    );
    expectError(await get(reg.port, "/v1/devices"), 401, "invalid_proof");

    const first = await mac.send("GET", "/v1/devices", {
      proof: { jti: "AAAAAAAAAAAAAAAAAAAAAA" },
    });
    assert.equal(first.status, 200);
    expectError(
      await mac.send("GET", "/v1/devices", { proof: { jti: "AAAAAAAAAAAAAAAAAAAAAA" } }),
      401,
      "invalid_proof",
    );

    for (const skew of [-121, 121]) {
      expectError(
        await mac.send("GET", "/v1/devices", { proof: { iat: reg.clock.now() + skew } }),
        401,
        "invalid_proof",
      );
    }
    for (const skew of [-120, 120]) {
      assert.equal(
        (await mac.send("GET", "/v1/devices", { proof: { iat: reg.clock.now() + skew } })).status,
        200,
      );
    }

    const stranger = new FakeDevice(reg, { name: "Stranger" });
    expectError(await stranger.send("GET", "/v1/devices"), 401, "device_unknown");
  });

  it("does not let a failed proof use up a jti, and logs the reason without echoing secrets", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const bad = await mac.send("GET", "/v1/devices", {
      proof: { jti: "BBBBBBBBBBBBBBBBBBBBBB", htu: "https://evil.example/v1/devices" },
    });
    assert.equal(bad.status, 401);
    assert.equal(
      (await mac.send("GET", "/v1/devices", { proof: { jti: "BBBBBBBBBBBBBBBBBBBBBB" } })).status,
      200,
    );
    assert.ok(
      reg.logs.some((entry) => entry.event === "proof_rejected" && entry.reason === "htu_mismatch"),
    );
    assert.ok(!JSON.stringify(reg.logs).includes("t3x-proof"));
  });
});

describe("GET /v1/devices", () => {
  it("lists every device with the contract's fields and tracks sync times", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const phone = await enroll(reg, { name: "Pixel", kind: "phone" });
    await mac.send("PATCH", "/v1/devices/self", { json: { environmentId: "env_mac" } });
    reg.clock.advance(30);

    const listing = await phone.send("GET", "/v1/devices");
    assert.equal(listing.status, 200);
    assert.equal(listing.headers.etag, undefined);
    assert.equal(listing.json.registryId, reg.store.registryId);
    assert.equal(listing.json.rev, reg.store.rev);
    const [first, second] = listing.json.devices;
    assert.deepEqual(first, {
      id: mac.id,
      name: "Mac",
      kind: "computer",
      jwk: mac.jwk,
      subdomain: "mac",
      url: "https://mac.registry.test",
      environmentId: "env_mac",
      createdAt: first.createdAt,
      lastSeenAt: first.lastSeenAt,
      online: false,
    });
    assert.equal(second.kind, "phone");
    assert.equal(second.subdomain, undefined);
    assert.equal(second.online, undefined);
    assert.equal(second.lastSyncAt, reg.clock.now());

    assert.equal(listing.headers["cache-control"], "no-store");
  });

  it("answers a conditional request with the current body, because online and sync times move without rev", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const phone = await enroll(reg, { name: "Pixel", kind: "phone" });
    const before = await phone.send("GET", "/v1/devices");
    assert.equal(before.json.devices.find((d) => d.id === mac.id).online, false);
    const rev = reg.store.rev;
    // What the frps plugin does on every Ping: the tunnel clock moves, rev does not.
    reg.clock.advance(5);
    reg.store.touch(mac.id, "tunnel", reg.clock.now());
    assert.equal(reg.store.rev, rev);

    const after = await phone.send("GET", "/v1/devices", {
      headers: { "if-none-match": `"${rev}"` },
    });
    assert.equal(after.status, 200);
    assert.equal(after.json.rev, rev);
    assert.equal(after.json.devices.find((d) => d.id === mac.id).online, true);
  });

  it("reports a computer online while its tunnel has been seen in the last 90 seconds", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    reg.store.touch(mac.id, "tunnel", reg.clock.now() - 89);
    assert.equal((await mac.send("GET", "/v1/devices")).json.devices[0].online, true);
    reg.store.touch(mac.id, "tunnel", reg.clock.now() - 91);
    assert.equal((await mac.send("GET", "/v1/devices")).json.devices[0].online, false);
  });

  it("tells a removed device it is unknown", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const phone = await enroll(reg, { name: "Pixel", kind: "phone" });
    assert.equal((await mac.send("DELETE", `/v1/devices/${phone.id}`)).status, 200);
    expectError(await phone.send("GET", "/v1/devices"), 401, "device_unknown");
  });
});

describe("invites", () => {
  it("creates, lists and cancels invites, only for computers", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const phone = await enroll(reg, { name: "Pixel", kind: "phone" });

    const created = await mac.send("POST", "/v1/invites", { json: { kind: "phone" } });
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.json).sort(), ["expiresAt", "id", "invite"]);
    assert.equal(created.json.expiresAt, reg.clock.now() + 900);
    const decoded = decodeInvite(created.json.invite);
    assert.deepEqual(
      {
        origin: decoded.origin,
        registryId: decoded.registryId,
        id: decoded.id,
        kind: decoded.kind,
        expiresAt: decoded.expiresAt,
      },
      {
        origin: "https://registry.test",
        registryId: reg.store.registryId,
        id: created.json.id,
        kind: "phone",
        expiresAt: created.json.expiresAt,
      },
    );

    const listed = await mac.send("GET", "/v1/invites");
    assert.deepEqual(listed.json, {
      invites: [
        {
          id: created.json.id,
          kind: "phone",
          createdBy: mac.id,
          expiresAt: created.json.expiresAt,
        },
      ],
    });

    expectError(
      await phone.send("POST", "/v1/invites", { json: { kind: "phone" } }),
      403,
      "forbidden",
    );
    expectError(await phone.send("GET", "/v1/invites"), 403, "forbidden");
    expectError(await phone.send("DELETE", `/v1/invites/${created.json.id}`), 403, "forbidden");

    const cancelled = await mac.send("DELETE", `/v1/invites/${created.json.id}`);
    assert.equal(cancelled.status, 204);
    assert.equal(cancelled.text, "");
    expectError(await mac.send("DELETE", `/v1/invites/${created.json.id}`), 404, "not_found");
    assert.deepEqual((await mac.send("GET", "/v1/invites")).json, { invites: [] });
  });

  it("only offers computer and phone through the API and a bare {kind}", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    for (const json of [{ kind: "any" }, { kind: "tablet" }, {}, { kind: "phone", extra: 1 }]) {
      expectError(await mac.send("POST", "/v1/invites", { json }), 400, "invalid_request");
    }
  });

  it("stops at 20 open invites with 409 too_many_invites", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    for (let i = 0; i < MAX_OPEN_INVITES; i += 1)
      reg.store.createInvite({ kind: "any", createdBy: "cli", now: reg.clock.now() });
    expectError(
      await mac.send("POST", "/v1/invites", { json: { kind: "phone" } }),
      409,
      "too_many_invites",
    );
  });

  it("limits one device to 10 new invites an hour", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    for (let i = 0; i < 10; i += 1) {
      const response = await mac.send("POST", "/v1/invites", { json: { kind: "phone" } });
      assert.equal(response.status, 201);
      await mac.send("DELETE", `/v1/invites/${response.json.id}`);
    }
    const blocked = expectError(
      await mac.send("POST", "/v1/invites", { json: { kind: "phone" } }),
      429,
      "rate_limited",
    );
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
    reg.clock.advance(3600);
    assert.equal((await mac.send("POST", "/v1/invites", { json: { kind: "phone" } })).status, 201);
  });
});

describe("removing, renaming and reporting", () => {
  it("removes devices: computers may remove anyone, phones only themselves", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const laptop = await enroll(reg, { name: "Laptop" });
    const pixel = await enroll(reg, { name: "Pixel", kind: "phone" });
    const galaxy = await enroll(reg, { name: "Galaxy", kind: "phone" });

    expectError(await pixel.send("DELETE", `/v1/devices/${galaxy.id}`), 403, "forbidden");
    expectError(await pixel.send("DELETE", `/v1/devices/${mac.id}`), 403, "forbidden");
    expectError(await mac.send("DELETE", `/v1/devices/${"A".repeat(43)}`), 404, "not_found");

    const removed = await mac.send("DELETE", `/v1/devices/${laptop.id}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json, { removedAt: reg.clock.now(), rev: reg.store.rev });
    assert.deepEqual(
      reg.store.listTombstones().map((t) => t.subdomain),
      ["laptop"],
    );

    const left = await pixel.send("DELETE", `/v1/devices/${pixel.id}`);
    assert.equal(left.status, 200);
    expectError(await pixel.send("GET", "/v1/devices"), 401, "device_unknown");
    assert.equal((await mac.send("DELETE", `/v1/devices/${mac.id}`)).status, 200);
  });

  it("renames: computers anyone, phones only themselves, never the subdomain", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const pixel = await enroll(reg, { name: "Pixel", kind: "phone" });
    const galaxy = await enroll(reg, { name: "Galaxy", kind: "phone" });

    const renamed = await mac.send("PATCH", `/v1/devices/${galaxy.id}`, { json: { name: "Tab" } });
    assert.deepEqual(renamed.json, { id: galaxy.id, name: "Tab" });
    assert.equal(
      (await pixel.send("PATCH", `/v1/devices/${pixel.id}`, { json: { name: "Mine" } })).status,
      200,
    );
    expectError(
      await pixel.send("PATCH", `/v1/devices/${galaxy.id}`, { json: { name: "Nope" } }),
      403,
      "forbidden",
    );
    expectError(
      await mac.send("PATCH", `/v1/devices/${pixel.id}`, { json: { name: "tab" } }),
      409,
      "name_taken",
    );
    expectError(
      await mac.send("PATCH", `/v1/devices/${pixel.id}`, { json: { name: "" } }),
      400,
      "name_invalid",
    );
    expectError(
      await mac.send("PATCH", `/v1/devices/${pixel.id}`, { json: { name: 5 } }),
      400,
      "name_invalid",
    );
    expectError(
      await mac.send("PATCH", `/v1/devices/${pixel.id}`, { json: { name: "x", more: 1 } }),
      400,
      "invalid_request",
    );
    expectError(
      await mac.send("PATCH", `/v1/devices/${"A".repeat(43)}`, { json: { name: "Ghost" } }),
      404,
      "not_found",
    );

    assert.equal(
      (await mac.send("PATCH", `/v1/devices/${mac.id}`, { json: { name: "Studio" } })).status,
      200,
    );
    assert.equal(reg.store.getDevice(mac.id).subdomain, "mac");
  });

  it("reports an environment id and validates its format", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const response = await mac.send("PATCH", "/v1/devices/self", {
      json: { environmentId: "0a1b-2c3d" },
    });
    assert.deepEqual(response.json, { rev: reg.store.rev });
    for (const json of [
      { environmentId: "has space" },
      { environmentId: "" },
      { environmentId: 3 },
      {},
      { environmentId: "ok", extra: 1 },
    ]) {
      expectError(await mac.send("PATCH", "/v1/devices/self", { json }), 400, "invalid_request");
    }
  });
});

describe("rate limits", () => {
  it("limits /v1/info to 60 a minute per client address and nothing else shares the bucket", async () => {
    for (let i = 0; i < 60; i += 1) assert.equal((await get(reg.port, "/v1/info")).status, 200);
    const blocked = expectError(await get(reg.port, "/v1/info"), 429, "rate_limited");
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
    assert.equal(
      (await get(reg.port, "/v1/info", { "x-t3x-client-ip": "198.51.100.2" })).status,
      200,
    );
    reg.clock.advance(61);
    assert.equal((await get(reg.port, "/v1/info")).status, 200);
  });

  it("limits every request, signed or not, to 300 a minute per client address", async () => {
    for (let i = 0; i < 300; i += 1) assert.equal((await get(reg.port, "/v1/nope")).status, 404);
    expectError(await get(reg.port, "/v1/nope"), 429, "rate_limited");
    expectError(await get(reg.port, "/v1/devices"), 429, "rate_limited");
    assert.equal(
      (await get(reg.port, "/v1/nope", { "x-t3x-client-ip": "198.51.100.9" })).status,
      404,
    );
  });

  it("limits an authenticated device to 120 requests a minute, separately per device", async () => {
    const mac = await enroll(reg, { name: "Mac", ip: "203.0.113.1" });
    const laptop = await enroll(reg, { name: "Laptop", ip: "203.0.113.2" });
    for (let i = 0; i < 120; i += 1)
      assert.equal((await mac.send("GET", "/v1/devices")).status, 200);
    expectError(await mac.send("GET", "/v1/devices"), 429, "rate_limited");
    assert.equal((await laptop.send("GET", "/v1/devices")).status, 200);
  });

  it("stops checking invites after 10 failed joins from one address, then recovers", async () => {
    const invite = await cliInvite(reg);
    for (let i = 0; i < 10; i += 1) {
      expectError(
        await new FakeDevice(reg, { name: `Guess ${i}` }).join(
          "AAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA",
        ),
        400,
        "invite_invalid",
      );
    }
    const valid = await new FakeDevice(reg, { name: "Legit" }).join(invite);
    const blocked = expectError(valid, 429, "rate_limited");
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
    assert.equal(reg.store.listDevices().length, 0);
    assert.equal(reg.store.listOpenInvites(reg.clock.now()).length, 1);

    const otherAddress = await new FakeDevice(reg, { name: "Elsewhere", ip: "203.0.113.50" }).join(
      invite,
    );
    assert.equal(otherAddress.status, 201);
  });

  it("recovers from the join limit after ten minutes", async () => {
    const guesser = new FakeDevice(reg, { name: "Guesser" });
    for (let i = 0; i < 10; i += 1)
      await guesser.send("POST", "/v1/join", { auth: "jwk", rawBody: Buffer.from("{}") });
    expectError(
      await guesser.send("POST", "/v1/join", { auth: "jwk", rawBody: Buffer.from("{}") }),
      429,
      "rate_limited",
    );
    reg.clock.advance(601);
    expectError(
      await guesser.send("POST", "/v1/join", { auth: "jwk", rawBody: Buffer.from("{}") }),
      400,
      "invalid_request",
    );
  });

  it("buckets by X-T3x-Client-IP only: other headers are ignored and bad values share one bucket", async () => {
    const spread = (i) => ({
      "x-forwarded-for": `10.0.0.${i % 250}`,
      forwarded: `for=10.0.0.${i % 250}`,
      "x-real-ip": `10.1.0.${i % 250}`,
    });
    for (let i = 0; i < 60; i += 1)
      assert.equal((await get(reg.port, "/v1/info", spread(i))).status, 200);
    expectError(await get(reg.port, "/v1/info", spread(61)), 429, "rate_limited");

    // Missing, non-IP and multi-valued headers all land in the same "unknown" bucket.
    const unknown = (headers) => rawRequest({ port: reg.port, path: "/v1/info", headers });
    for (let i = 0; i < 20; i += 1) assert.equal((await unknown({})).status, 200);
    for (let i = 0; i < 20; i += 1)
      assert.equal((await unknown({ "x-t3x-client-ip": "not-an-ip" })).status, 200);
    for (let i = 0; i < 20; i += 1)
      assert.equal((await unknown({ "x-t3x-client-ip": "1.2.3.4, 5.6.7.8" })).status, 200);
    expectError(await unknown({ "x-t3x-client-ip": "also bad" }), 429, "rate_limited");
  });
});

describe("overload and failure", () => {
  it("answers 503 busy once 128 requests are in flight", async () => {
    const stalled = [];
    for (let i = 0; i < MAX_IN_FLIGHT; i += 1) {
      const socket = connect(reg.port, "127.0.0.1");
      socket.on("error", () => {});
      socket.write(
        `POST /v1/invites HTTP/1.1\r\nhost: registry.test\r\nx-t3x-client-ip: 198.51.100.${(i % 200) + 1}\r\ncontent-length: 10\r\n\r\nab`,
      );
      stalled.push(socket);
    }
    await reg.requestsReceived(MAX_IN_FLIGHT);
    const busy = await get(reg.port, "/v1/info", { "x-t3x-client-ip": "192.0.2.1" });
    assert.equal(busy.status, 503);
    assert.equal(busy.json.error, "busy");
    for (const socket of stalled) socket.destroy();
  });

  it("returns a bare 500 internal for unexpected errors and logs the detail", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    reg.store.db.exec("DROP TABLE seen_jti");
    const response = expectError(await mac.send("GET", "/v1/devices"), 500, "internal");
    assert.ok(!response.text.includes("seen_jti"));
    assert.ok(
      reg.logs.some((entry) => entry.event === "internal_error" && /seen_jti/.test(entry.message)),
    );
  });

  it("logs joins with the address and the device name, and never the invite secret", async () => {
    const invite = await cliInvite(reg);
    const decoded = decodeInvite(invite);
    await new FakeDevice(reg, { name: "Audit Mac", ip: "203.0.113.77" }).join(invite);
    const entry = reg.logs.find((e) => e.event === "joined");
    assert.equal(entry.name, "Audit Mac");
    assert.equal(entry.ip, "203.0.113.77");
    assert.ok(!JSON.stringify(reg.logs).includes(decoded.secret));
  });

  it("warns once when requests arrive for another Host, without changing any answer", async () => {
    assert.equal((await get(reg.port, "/v1/info", { host: "evil.example" })).status, 200);
    assert.equal(reg.logs.filter((e) => e.event === "host_mismatch").length, 1);
    assert.equal(reg.logs.find((e) => e.event === "host_mismatch").host, "evil.example");
  });
});

describe("configuration", () => {
  it("canonicalises T3X_PUBLIC_ORIGIN and refuses to start without a usable one", () => {
    const config = loadConfig({
      T3X_PUBLIC_ORIGIN: "HTTPS://T3.Localhost:18443/",
      T3X_DB_PATH: "/tmp/x.db",
    });
    assert.equal(config.publicOrigin, "https://t3.localhost:18443");
    assert.equal(config.domain, "t3.localhost");
    assert.equal(config.publicPort, 18443);
    assert.equal(loadConfig({ T3X_PUBLIC_ORIGIN: "https://t3.example.com" }).publicPort, 443);
    assert.equal(loadConfig({ T3X_PUBLIC_ORIGIN: "https://t3.example.com" }).ntfyInstalled, false);
    assert.equal(
      loadConfig({ T3X_PUBLIC_ORIGIN: "https://t3.example.com", T3X_NTFY_ENABLED: "1" })
        .ntfyInstalled,
      true,
    );
    for (const bad of [
      undefined,
      "",
      "http://t3.example.com",
      "https://t3.example.com/x",
      "https://t3.example.com?x",
      `https://${"a".repeat(80)}.example.com`,
    ]) {
      assert.throws(() => loadConfig({ T3X_PUBLIC_ORIGIN: bad }), undefined, String(bad));
    }
  });

  it("normalises the Host header for the logs only", () => {
    assert.equal(normalizeHostForLog("T3.Example.COM:443"), "t3.example.com");
    assert.equal(normalizeHostForLog("例え.jp"), "xn--r8jz45g.jp");
    assert.equal(normalizeHostForLog("[::1]:8080"), "[::1]");
    assert.equal(normalizeHostForLog("a".repeat(400)).length, 255);
    assert.equal(normalizeHostForLog(undefined), "");
  });
});

describe("computer visibility", () => {
  const listing = async (device) => (await device.send("GET", "/v1/devices")).json;
  const ids = (body) => body.devices.map((d) => d.id);
  const setVisibility = (device, mode, deviceIds = []) =>
    device.send("PUT", "/v1/devices/self/visibility", { json: { mode, deviceIds } });

  it("lists every device to everyone by default and shows a computer only its own setting", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const laptop = await enroll(reg, { name: "Laptop" });
    const phone = await enroll(reg, { name: "Pixel", kind: "phone" });
    const asMac = await listing(mac);
    assert.deepEqual(ids(asMac), [mac.id, laptop.id, phone.id]);
    assert.equal(asMac.hiddenPeers, undefined);
    assert.deepEqual(asMac.devices[0].visibility, { mode: "visible_to_all", deviceIds: [] });
    assert.equal(asMac.devices[1].visibility, undefined);
    assert.equal(asMac.devices[2].visibility, undefined);
    assert.equal(
      (await listing(phone)).devices.some((d) => "visibility" in d),
      false,
    );
  });

  it("answers the owner with the stored setting and moves the rev", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const laptop = await enroll(reg, { name: "Laptop" });
    const rev = reg.store.rev;
    const set = await setVisibility(mac, "hidden_from_selected", [laptop.id, laptop.id]);
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.json, {
      rev: rev + 1,
      visibility: { mode: "hidden_from_selected", deviceIds: [laptop.id] },
    });
    assert.equal((await setVisibility(mac, "hidden_from_selected", [laptop.id])).json.rev, rev + 1);
    assert.deepEqual((await listing(mac)).devices[0].visibility, set.json.visibility);
  });

  it("hides a computer from the devices it is hidden from, and from nobody else", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const laptop = await enroll(reg, { name: "Laptop" });
    const studio = await enroll(reg, { name: "Studio" });
    const phone = await enroll(reg, { name: "Pixel", kind: "phone" });
    await setVisibility(mac, "hidden_from_selected", [laptop.id, phone.id]);

    for (const hidden of [laptop, phone]) {
      const body = await listing(hidden);
      assert.equal(ids(body).includes(mac.id), false);
      assert.equal(ids(body).includes(hidden.id), true);
    }
    assert.equal(ids(await listing(studio)).includes(mac.id), true);
    assert.deepEqual(ids(await listing(mac)), [mac.id, laptop.id, studio.id, phone.id]);
  });

  it("hands a hidden viewer only the identity of a hidden computer, so passes it signs can still be checked", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const laptop = await enroll(reg, { name: "Laptop" });
    const phone = await enroll(reg, { name: "Pixel", kind: "phone" });
    await mac.send("PATCH", "/v1/devices/self", { json: { environmentId: "env_mac" } });
    await setVisibility(mac, "hidden_from_all");
    const body = await listing(laptop);
    assert.deepEqual(body.hiddenPeers, [{ id: mac.id, kind: "computer", jwk: mac.jwk }]);
    assert.equal(
      body.devices.some((d) => d.id === mac.id),
      false,
    );
    assert.equal(JSON.stringify(body).includes("env_mac"), false);
    assert.equal(JSON.stringify(body).includes("https://mac."), false);
    assert.equal((await listing(mac)).hiddenPeers, undefined);
    // A phone never checks a pass, so it gets no identity for a computer hidden from it.
    const forPhone = await listing(phone);
    assert.equal(forPhone.hiddenPeers, undefined);
    assert.equal(
      forPhone.devices.some((d) => d.id === mac.id),
      false,
    );
  });

  it("hides a hidden computer's open invites from the devices it is hidden from, and refuses their cancel as not found", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const laptop = await enroll(reg, { name: "Laptop" });
    const studio = await enroll(reg, { name: "Studio" });
    await setVisibility(mac, "hidden_from_selected", [laptop.id]);
    const macInvite = (await mac.send("POST", "/v1/invites", { json: { kind: "phone" } })).json;
    const studioInvite = (await studio.send("POST", "/v1/invites", { json: { kind: "phone" } }))
      .json;
    const invitesFor = async (device) =>
      (await device.send("GET", "/v1/invites")).json.invites.map((invite) => invite.id);

    assert.deepEqual(await invitesFor(laptop), [studioInvite.id]);
    assert.deepEqual((await invitesFor(studio)).sort(), [macInvite.id, studioInvite.id].sort());
    assert.deepEqual((await invitesFor(mac)).sort(), [macInvite.id, studioInvite.id].sort());

    const refused = await laptop.send("DELETE", `/v1/invites/${macInvite.id}`);
    const unknown = await laptop.send("DELETE", `/v1/invites/${"a".repeat(11)}`);
    expectError(refused, 404, "not_found");
    assert.deepEqual(refused.json, unknown.json);
    assert.deepEqual((await invitesFor(mac)).includes(macInvite.id), true);
    assert.equal((await studio.send("DELETE", `/v1/invites/${macInvite.id}`)).status, 204);
  });

  it("applies the four modes, including to a device that joins afterwards", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const early = await enroll(reg, { name: "Early" });
    const seesMac = async (viewer) => ids(await listing(viewer)).includes(mac.id);
    const cases = [
      ["visible_to_all", [], true, true],
      ["hidden_from_all", [], false, false],
      ["hidden_from_selected", [early.id], false, true],
      ["visible_to_selected", [early.id], true, false],
    ];
    for (const [mode, selected, earlySees, lateSees] of cases) {
      await setVisibility(mac, mode, selected);
      const late = await enroll(reg, { name: `Late ${mode}` });
      assert.equal(await seesMac(early), earlySees, `${mode}: early`);
      assert.equal(await seesMac(late), lateSees, `${mode}: late`);
    }
  });

  it("refuses to let a hidden device remove or rename the computer, as if it did not exist", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const laptop = await enroll(reg, { name: "Laptop" });
    const studio = await enroll(reg, { name: "Studio" });
    await setVisibility(mac, "hidden_from_selected", [laptop.id]);
    expectError(await laptop.send("DELETE", `/v1/devices/${mac.id}`), 404, "not_found");
    expectError(
      await laptop.send("PATCH", `/v1/devices/${mac.id}`, { json: { name: "Mine" } }),
      404,
      "not_found",
    );
    assert.notEqual(reg.store.getDevice(mac.id), null);
    assert.equal(reg.store.getDevice(mac.id).name, "Mac");
    // A device it is not hidden from, and the computer itself, still can.
    assert.equal(
      (await studio.send("PATCH", `/v1/devices/${mac.id}`, { json: { name: "Mac2" } })).status,
      200,
    );
    assert.equal((await mac.send("DELETE", `/v1/devices/${mac.id}`)).status, 200);
  });

  it("lets only a computer set its own visibility, with a valid body", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const phone = await enroll(reg, { name: "Pixel", kind: "phone" });
    expectError(await setVisibility(phone, "hidden_from_all"), 403, "forbidden");
    const bad = [
      { mode: "everyone", deviceIds: [] },
      { mode: "hidden_from_all" },
      { mode: "hidden_from_all", deviceIds: "x" },
      { mode: "hidden_from_selected", deviceIds: ["short"] },
      { mode: "hidden_from_selected", deviceIds: [mac.id] },
      {
        mode: "hidden_from_selected",
        deviceIds: Array.from({ length: 65 }, (_, i) => `${String(i).padStart(43, "a")}`),
      },
      { mode: "hidden_from_all", deviceIds: [], extra: 1 },
    ];
    for (const json of bad) {
      expectError(
        await mac.send("PUT", "/v1/devices/self/visibility", { json }),
        400,
        "invalid_request",
      );
    }
    assert.deepEqual(reg.store.getDevice(mac.id).visibility, {
      mode: "visible_to_all",
      deviceIds: [],
    });
    expectError(
      await mac.send("PATCH", "/v1/devices/self/visibility", {
        json: { mode: "hidden_from_all", deviceIds: [] },
      }),
      405,
      "method_not_allowed",
    );
  });

  it("stops listing a hidden device's entry only for the viewer, so the device is never told it was removed", async () => {
    const mac = await enroll(reg, { name: "Mac" });
    const laptop = await enroll(reg, { name: "Laptop" });
    await setVisibility(laptop, "hidden_from_all");
    const asLaptop = await laptop.send("GET", "/v1/devices");
    assert.equal(asLaptop.status, 200);
    assert.equal(ids(asLaptop.json).includes(laptop.id), true);
    assert.equal(
      (await mac.send("GET", "/v1/devices")).json.devices.some((d) => d.id === laptop.id),
      false,
    );
  });
});
