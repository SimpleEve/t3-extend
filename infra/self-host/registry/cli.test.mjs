import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { runCli } from "./cli.mjs";
import { Store } from "./db.mjs";
import { decodeInvite } from "./invites.mjs";
import { generateDeviceKey } from "./proof.mjs";
import { createClock, testConfig } from "./testkit.mjs";

const assert = NodeAssert;
const { mkdtempSync, rmSync } = NodeFS;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { afterEach, beforeEach, describe, it } = NodeTest;

const clock = createClock();
let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t3x-cli-test-"));
  store = Store.open(join(dir, "registry.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function cli(argv, renderQr = () => "QR-CODE") {
  const lines = { out: [], err: [] };
  const code = runCli(argv, {
    store,
    config: testConfig(),
    now: clock.now,
    out: (text) => lines.out.push(text),
    err: (text) => lines.err.push(text),
    renderQr,
  });
  return { code, out: lines.out.join("\n"), err: lines.err.join("\n") };
}

function join_(kind, name) {
  const key = generateDeviceKey();
  const invite = store.createInvite({ kind, createdBy: "cli", now: clock.now() });
  store.join({
    inviteId: invite.id,
    secret: invite.secret,
    device: { ...key, name, kind },
    now: clock.now(),
  });
  return key;
}

describe("./t3x invite", () => {
  it("prints a decodable invite and the QR code", () => {
    const result = cli(["invite", "--kind", "computer"]);
    assert.equal(result.code, 0);
    const text = result.out.split("\n").find((line) => line.startsWith("t3x1."));
    const invite = decodeInvite(text);
    assert.equal(invite.kind, "computer");
    assert.equal(invite.origin, "https://registry.test");
    assert.equal(invite.registryId, store.registryId);
    assert.match(result.out, /QR-CODE/);
    assert.equal(result.err, "");
  });

  it("falls back to plain text with a clear message when qrencode is missing", () => {
    const result = cli(["invite"], () => null);
    assert.equal(result.code, 0);
    assert.ok(result.out.includes("t3x1."));
    assert.equal(result.err, "二维码工具不可用，请直接复制上面的字符串");
    assert.ok(!result.out.includes("QR-CODE"));
  });

  it("skips the QR code with --no-qr and rejects bad kinds and flags", () => {
    let called = false;
    cli(["invite", "--no-qr"], () => {
      called = true;
      return "QR";
    });
    assert.equal(called, false);
    assert.equal(cli(["invite", "--kind", "tablet"]).code, 1);
    assert.equal(cli(["invite", "--wat"]).code, 1);
  });

  it("stops at 20 open invites", () => {
    for (let i = 0; i < 20; i += 1) assert.equal(cli(["invite"]).code, 0);
    const result = cli(["invite"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /20/);
  });
});

describe("./t3x devices, revoke, rename, release, info", () => {
  it("lists, renames and revokes by name or id, leaving a tombstone", () => {
    assert.match(cli(["devices"]).out, /还没有设备/);
    const mac = join_("computer", "Mac");
    join_("phone", "Pixel");
    const listing = cli(["devices"]).out;
    assert.match(listing, /Mac\s+电脑\s+mac/);
    assert.match(listing, /Pixel\s+手机/);

    assert.equal(cli(["rename", "mac", "Studio"]).code, 0);
    assert.equal(store.getDevice(mac.id).name, "Studio");
    assert.equal(store.getDevice(mac.id).subdomain, "mac");

    const revoked = cli(["revoke", "Studio"]);
    assert.equal(revoked.code, 0);
    assert.match(revoked.out, /release mac/);
    assert.equal(store.getDevice(mac.id), null);
    assert.equal(cli(["revoke", "Studio"]).code, 1);
    assert.equal(cli(["revoke", join_("phone", "Galaxy").id.slice(0, 10)]).code, 0);
    assert.equal(cli(["revoke", "short"]).code, 1);
  });

  it("lists every device and marks the computers that hide from others, by name", () => {
    const mac = join_("computer", "Mac");
    const laptop = join_("computer", "Laptop");
    const studio = join_("computer", "Studio");
    join_("phone", "Pixel");
    const plain = cli(["devices"]).out.split("\n");
    assert.equal(plain.filter((l) => /可见性：对所有设备可见$/.test(l)).length, 3);
    assert.doesNotMatch(
      plain.find((l) => l.startsWith("Pixel")),
      /可见性/,
    );

    store.setVisibility(mac.id, "hidden_from_all", []);
    store.setVisibility(laptop.id, "hidden_from_selected", [studio.id]);
    store.setVisibility(studio.id, "visible_to_selected", [mac.id, laptop.id]);
    const lines = cli(["devices"]).out.split("\n");
    assert.equal(lines.length, 4);
    assert.match(
      lines.find((l) => l.startsWith("Mac")),
      /可见性：对所有设备隐藏$/,
    );
    assert.match(
      lines.find((l) => l.startsWith("Laptop")),
      /可见性：对 Studio 隐藏$/,
    );
    assert.match(
      lines.find((l) => l.startsWith("Studio")),
      /可见性：仅对 Laptop、Mac 可见$/,
    );
    assert.doesNotMatch(
      lines.find((l) => l.startsWith("Pixel")),
      /可见性/,
    );
    // A hidden computer can still be revoked from the server.
    assert.equal(cli(["revoke", "Mac"]).code, 0);
  });

  it("warns about computers that have not synced the removal", () => {
    join_("computer", "Mac");
    const laptop = join_("computer", "Laptop");
    const result = cli(["revoke", laptop.id]);
    assert.match(result.out, /电脑「Mac」还没同步/);
  });

  it("releases a tombstoned subdomain and reports on info", () => {
    const mac = join_("computer", "Mac");
    cli(["revoke", mac.id]);
    assert.match(cli(["info"]).out, /已回收前不会再分配的子域名：1/);
    assert.equal(cli(["release", "nope"]).code, 1);
    assert.equal(cli(["release", "mac"]).code, 0);
    assert.match(cli(["info"]).out, /子域名：0/);
    assert.match(cli(["info"]).out, new RegExp(store.registryId));
  });

  it("lists open invites and prints usage for unknown commands", () => {
    assert.match(cli(["invites"]).out, /没有待用的邀请/);
    cli(["invite", "--kind", "phone"]);
    assert.match(cli(["invites"]).out, /phone\s+创建者 cli/);
    assert.equal(cli([]).code, 0);
    assert.equal(cli(["bogus"]).code, 2);
    assert.match(cli(["bogus"]).err, /用法/);
    assert.equal(cli(["ntfy"]).code, 1);
  });
});
