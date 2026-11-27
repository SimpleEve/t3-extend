import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeWorkerThreads from "node:worker_threads";

import {
  INVITE_TTL_SECONDS,
  MAX_OPEN_INVITES,
  Store,
  StoreError,
  hashSecret,
  isVisibleTo,
} from "./db.mjs";
import { generateDeviceKey } from "./proof.mjs";

const assert = NodeAssert;
const { mkdtempSync, rmSync } = NodeFS;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { afterEach, beforeEach, describe, it } = NodeTest;
const { Worker } = NodeWorkerThreads;

const NOW = 1_800_000_000;

let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t3x-db-test-"));
  store = Store.open(join(dir, "registry.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const newDevice = (kind, name) => ({ ...generateDeviceKey(), kind, name });
const enroll = (kind, name, inviteKind = "any", now = NOW) => {
  const invite = store.createInvite({ kind: inviteKind, createdBy: "cli", now });
  const device = newDevice(kind, name);
  const result = store.join({ inviteId: invite.id, secret: invite.secret, device, now });
  return { invite, device, ...result };
};
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StoreError, String(error));
    return error.code;
  }
  return "no error";
};

describe("schema constraints (rows inserted around the application code)", () => {
  const insertDevice = (overrides = {}) => {
    const row = {
      id: generateDeviceKey().id,
      name: "n",
      name_key: "n",
      kind: "computer",
      jwk: "{}",
      subdomain: "s",
      created_at: NOW,
      invite_id: null,
      ...overrides,
    };
    store.db
      .prepare(
        "INSERT INTO devices (id, name, name_key, kind, jwk, subdomain, created_at, invite_id) VALUES (:id, :name, :name_key, :kind, :jwk, :subdomain, :created_at, :invite_id)",
      )
      .run(row);
  };

  it("refuses duplicate ids, name keys, subdomains and invite ids", () => {
    insertDevice({ id: "same", name_key: "a", subdomain: "a", invite_id: "i1" });
    assert.throws(() => insertDevice({ id: "same", name_key: "b", subdomain: "b" }), /devices\.id/);
    assert.throws(
      () => insertDevice({ id: "x", name_key: "a", subdomain: "b" }),
      /devices\.name_key/,
    );
    assert.throws(
      () => insertDevice({ id: "x", name_key: "b", subdomain: "a" }),
      /devices\.subdomain/,
    );
    assert.throws(
      () => insertDevice({ id: "x", name_key: "b", subdomain: "b", invite_id: "i1" }),
      /devices\.invite_id/,
    );
  });

  it("allows many devices without a subdomain or invite id", () => {
    insertDevice({ id: "p1", name_key: "p1", kind: "phone", subdomain: null });
    insertDevice({ id: "p2", name_key: "p2", kind: "phone", subdomain: null });
  });

  it("checks the kind and that only computers have a subdomain", () => {
    assert.throws(() => insertDevice({ id: "w", kind: "watch" }), /CHECK/);
    assert.throws(() => insertDevice({ id: "p", kind: "phone", subdomain: "p" }), /CHECK/);
    assert.throws(
      () =>
        store.db
          .prepare(
            "INSERT INTO invites (id, secret_hash, kind, created_by, created_at, expires_at) VALUES ('i', 'h', 'tablet', 'cli', 0, 0)",
          )
          .run(),
      /CHECK/,
    );
  });

  it("refuses a second (device, jti) and a second tombstone for a subdomain", () => {
    store.db.prepare("INSERT INTO seen_jti (device_id, jti, exp) VALUES ('d', 'j', 1)").run();
    assert.throws(
      () =>
        store.db.prepare("INSERT INTO seen_jti (device_id, jti, exp) VALUES ('d', 'j', 2)").run(),
      /seen_jti/,
    );
    store.db
      .prepare("INSERT INTO tombstones (subdomain, device_id, removed_at) VALUES ('s', 'd', 1)")
      .run();
    assert.throws(
      () =>
        store.db
          .prepare("INSERT INTO tombstones (subdomain, device_id, removed_at) VALUES ('s', 'e', 2)")
          .run(),
      /tombstones/,
    );
  });

  it("keeps meta to a single row", () => {
    assert.throws(
      () => store.db.prepare("INSERT INTO meta (id, registry_id, rev) VALUES (2, 'x', 1)").run(),
      /CHECK/,
    );
  });
});

describe("recordJti", () => {
  it("reports a repeated jti as a replay and lets the same jti through for another device", () => {
    assert.equal(store.recordJti("d1", "j", NOW + 240), true);
    assert.equal(store.recordJti("d1", "j", NOW + 240), false);
    assert.equal(store.recordJti("d2", "j", NOW + 240), true);
  });

  it("forgets a jti once it is purged", () => {
    store.recordJti("d1", "old", NOW - 1);
    store.recordJti("d1", "fresh", NOW + 240);
    assert.equal(store.purge(NOW).jti, 1);
    assert.equal(store.recordJti("d1", "old", NOW + 240), true);
    assert.equal(store.recordJti("d1", "fresh", NOW + 240), false);
  });
});

describe("invites", () => {
  it("stores only the hash of the secret and expires after 15 minutes", () => {
    const invite = store.createInvite({ kind: "phone", createdBy: "cli", now: NOW });
    assert.equal(invite.expiresAt, NOW + INVITE_TTL_SECONDS);
    assert.equal(invite.id.length, 11);
    assert.equal(invite.secret.length, 22);
    const row = store.db.prepare("SELECT * FROM invites WHERE id = ?").get(invite.id);
    assert.equal(row.secret_hash, hashSecret(invite.secret));
    assert.ok(!JSON.stringify(row).includes(invite.secret));
  });

  it("caps open invites at 20 and counts only unused, unexpired ones", () => {
    for (let i = 0; i < MAX_OPEN_INVITES; i += 1)
      store.createInvite({ kind: "any", createdBy: "cli", now: NOW });
    assert.equal(
      code(() => store.createInvite({ kind: "any", createdBy: "cli", now: NOW })),
      "too_many_invites",
    );
    store.createInvite({ kind: "any", createdBy: "cli", now: NOW + INVITE_TTL_SECONDS });
  });

  it("classifies a failed redemption: unknown/wrong secret, expired, used, wrong kind", () => {
    const invite = store.createInvite({ kind: "computer", createdBy: "cli", now: NOW });
    const attempt = (overrides = {}) => {
      const device = newDevice("computer", `D${Math.random()}`);
      return store.join({
        inviteId: invite.id,
        secret: invite.secret,
        device: { id: device.id, name: device.name, kind: "computer", jwk: device.jwk },
        now: NOW,
        ...overrides,
      });
    };
    assert.equal(
      code(() => attempt({ inviteId: "AAAAAAAAAAA" })),
      "invite_invalid",
    );
    assert.equal(
      code(() => attempt({ secret: "A".repeat(22) })),
      "invite_invalid",
    );
    assert.equal(
      code(() => attempt({ now: NOW + INVITE_TTL_SECONDS })),
      "invite_expired",
    );
    const phone = newDevice("phone", "Phone");
    assert.equal(
      code(() =>
        store.join({
          inviteId: invite.id,
          secret: invite.secret,
          device: { id: phone.id, name: "Phone", kind: "phone", jwk: phone.jwk },
          now: NOW,
        }),
      ),
      "kind_mismatch",
    );
    attempt();
    assert.equal(
      code(() => attempt()),
      "invite_used",
    );
  });

  it("rolls back the consumption when the join fails afterwards", () => {
    const first = enroll("computer", "Mac");
    const invite = store.createInvite({ kind: "any", createdBy: "cli", now: NOW });
    // The same key is already registered, so the INSERT fails after the invite was marked used.
    assert.equal(
      code(() =>
        store.join({
          inviteId: invite.id,
          secret: invite.secret,
          device: { id: first.device.id, name: "Other", kind: "computer", jwk: first.device.jwk },
          now: NOW,
        }),
      ),
      "device_exists",
    );
    assert.equal(
      store.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(invite.id).used_at,
      null,
    );
  });

  it("removes an invite only while it is unused", () => {
    const invite = store.createInvite({ kind: "any", createdBy: "cli", now: NOW });
    assert.equal(store.deleteInvite(invite.id), true);
    assert.equal(store.deleteInvite(invite.id), false);
    const used = enroll("phone", "Phone");
    assert.equal(store.deleteInvite(used.invite.id), false);
  });

  it("lets two connections race for each invite and gives every invite exactly one winner", async () => {
    const invites = Array.from({ length: MAX_OPEN_INVITES }, () =>
      store.createInvite({ kind: "any", createdBy: "cli", now: NOW }),
    );
    const barrier = new SharedArrayBuffer(8);
    const gate = new Int32Array(barrier);
    const run = (label) => {
      const worker = new Worker(new URL("./join-race-worker.mjs", import.meta.url), {
        workerData: { dbPath: join(dir, "registry.db"), invites, label, barrier, now: NOW },
      });
      const next = () =>
        new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        });
      return { ready: next(), results: null, worker, next };
    };
    const racers = ["a", "b", "c"].map(run);
    await Promise.all(racers.map((racer) => racer.ready));
    for (const racer of racers) racer.results = racer.next();
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const results = (await Promise.all(racers.map((racer) => racer.results))).flatMap(
      (message) => message.results,
    );
    for (const invite of invites) {
      const outcomes = results.filter((r) => r.invite === invite.id);
      assert.equal(outcomes.filter((r) => r.ok).length, 1, `invite ${invite.id}`);
      assert.deepEqual(
        new Set(outcomes.filter((r) => !r.ok).map((r) => r.code)),
        new Set(["invite_used"]),
      );
    }
    assert.equal(store.listDevices().length, invites.length);
  });
});

describe("names and subdomains", () => {
  it("adds (2) to a duplicate display name, case-insensitively", () => {
    enroll("phone", "Pixel");
    assert.equal(store.getDevice(enroll("phone", "pixel").device.id).name, "pixel (2)");
    assert.equal(
      store
        .listDevices()
        .map((d) => d.name)
        .sort()
        .join("|"),
      "Pixel|pixel (2)",
    );
  });

  it("derives and de-duplicates computer subdomains, and gives phones none", () => {
    const phone = enroll("phone", "Phone");
    assert.equal(store.getDevice(phone.device.id).subdomain, null);
    const mac = enroll("computer", "My Mac");
    const another = enroll("computer", "My Mac!");
    assert.equal(store.getDevice(mac.device.id).subdomain, "my-mac");
    assert.equal(store.getDevice(another.device.id).subdomain, "my-mac-2");
  });

  it("avoids reserved names and falls back for names with no latin letters", () => {
    enroll("computer", "api");
    enroll("computer", "电脑");
    const subdomains = store.listDevices().map((d) => d.subdomain);
    assert.ok(subdomains.includes("api-2"));
    assert.ok(subdomains.some((s) => /^computer-[a-z2-7]{4}$/.test(s)));
  });

  it("never reassigns a removed computer's subdomain until the administrator releases it", () => {
    const mac = enroll("computer", "Mac");
    assert.equal(store.getDevice(mac.device.id).subdomain, "mac");
    const removed = store.removeDevice(mac.device.id, NOW + 10);
    assert.equal(removed.rev, store.rev);
    assert.equal(store.getDevice(mac.device.id), null);
    assert.deepEqual(
      store.listTombstones().map((t) => t.subdomain),
      ["mac"],
    );

    assert.equal(store.getDevice(enroll("computer", "Mac").device.id).subdomain, "mac-2");
    assert.equal(store.releaseSubdomain("mac"), true);
    assert.equal(store.releaseSubdomain("mac"), false);
    assert.equal(store.getDevice(enroll("computer", "Mac").device.id).subdomain, "mac");
  });

  it("rolls the whole join back when no subdomain is free", () => {
    for (let n = 1; n <= 20; n += 1)
      store.db
        .prepare("INSERT INTO tombstones (subdomain, device_id, removed_at) VALUES (?, 'x', 1)")
        .run(n === 1 ? "mac" : `mac-${n}`);
    const invite = store.createInvite({ kind: "any", createdBy: "cli", now: NOW });
    const device = newDevice("computer", "Mac");
    assert.equal(
      code(() =>
        store.join({
          inviteId: invite.id,
          secret: invite.secret,
          device: { id: device.id, name: "Mac", kind: "computer", jwk: device.jwk },
          now: NOW,
        }),
      ),
      "name_taken",
    );
    assert.equal(store.getDevice(device.id), null);
    assert.equal(
      store.db.prepare("SELECT used_at FROM invites WHERE id = ?").get(invite.id).used_at,
      null,
    );
  });
});

describe("membership changes", () => {
  it("bumps the rev for join, remove, rename and a changed environment id, but not for a repeat", () => {
    const start = store.rev;
    const mac = enroll("computer", "Mac");
    assert.equal(store.rev, start + 1);
    assert.equal(store.setEnvironmentId(mac.device.id, "env-1"), start + 2);
    assert.equal(store.setEnvironmentId(mac.device.id, "env-1"), start + 2);
    assert.equal(store.renameDevice(mac.device.id, "Studio"), start + 3);
    assert.equal(store.removeDevice(mac.device.id, NOW).rev, start + 4);
    assert.equal(store.removeDevice(mac.device.id, NOW), null);
    assert.equal(store.setEnvironmentId(mac.device.id, "env-1"), null);
  });

  it("refuses a rename onto another device's name but allows a case change of its own", () => {
    enroll("phone", "Pixel");
    const other = enroll("phone", "Galaxy");
    assert.equal(
      code(() => store.renameDevice(other.device.id, "PIXEL")),
      "name_taken",
    );
    assert.ok(store.renameDevice(other.device.id, "GALAXY") > 0);
  });

  it("cancels the unused invites of a device that is removed", () => {
    const mac = enroll("computer", "Mac");
    const pending = store.createInvite({ kind: "phone", createdBy: mac.device.id, now: NOW });
    const mine = store.createInvite({ kind: "phone", createdBy: "cli", now: NOW });
    store.removeDevice(mac.device.id, NOW);
    assert.equal(store.deleteInvite(pending.id), false);
    assert.equal(store.deleteInvite(mine.id), true);
  });
});

describe("last-seen bookkeeping", () => {
  it("overlays unflushed timestamps and writes them in one batch", () => {
    const mac = enroll("computer", "Mac");
    store.touch(mac.device.id, "seen", NOW + 5);
    store.touch(mac.device.id, "tunnel", NOW + 6);
    store.touch("gone", "seen", NOW);
    const overlaid = store.withTouches(store.getDevice(mac.device.id));
    assert.equal(overlaid.lastSeenAt, NOW + 5);
    assert.equal(overlaid.lastTunnelAt, NOW + 6);
    assert.equal(store.getDevice(mac.device.id).lastTunnelAt, null);

    assert.equal(store.flushTouches(), 2);
    assert.equal(store.getDevice(mac.device.id).lastTunnelAt, NOW + 6);
    assert.equal(store.flushTouches(), 0);
  });
});

describe("opening the database", () => {
  it("keeps the registry id and rev across reopen and refuses a newer schema", () => {
    const { registryId, rev } = store;
    assert.match(registryId, /^[a-z2-7]{8}$/);
    store.close();
    const path = join(dir, "registry.db");
    store = Store.open(path);
    assert.equal(store.registryId, registryId);
    assert.equal(store.rev, rev);
    store.db.exec("PRAGMA user_version = 99");
    store.close();
    assert.throws(() => Store.open(path), /schema 99/);
    store = Store.open(join(dir, "other.db"));
  });
});

describe("computer visibility", () => {
  const view = (owner, viewerId) => isVisibleTo(store.getDevice(owner.device.id), viewerId);

  it("starts visible to everyone, and a phone is never hidden", () => {
    const mac = enroll("computer", "Mac");
    const phone = enroll("phone", "Pixel");
    assert.deepEqual(store.getDevice(mac.device.id).visibility, {
      mode: "visible_to_all",
      deviceIds: [],
    });
    assert.equal(view(mac, phone.device.id), true);
    assert.equal(
      code(() => store.setVisibility(phone.device.id, "hidden_from_all", [])),
      "invalid_request",
    );
  });

  it("applies each of the four modes to a viewer, and the owner always sees itself", () => {
    const mac = enroll("computer", "Mac");
    const laptop = enroll("computer", "Laptop");
    const phone = enroll("phone", "Pixel");
    const selected = [laptop.device.id];

    store.setVisibility(mac.device.id, "hidden_from_all", []);
    assert.deepEqual(
      [view(mac, laptop.device.id), view(mac, phone.device.id), view(mac, mac.device.id)],
      [false, false, true],
    );
    store.setVisibility(mac.device.id, "hidden_from_selected", selected);
    assert.deepEqual([view(mac, laptop.device.id), view(mac, phone.device.id)], [false, true]);
    store.setVisibility(mac.device.id, "visible_to_selected", selected);
    assert.deepEqual([view(mac, laptop.device.id), view(mac, phone.device.id)], [true, false]);
    store.setVisibility(mac.device.id, "visible_to_all", selected);
    assert.deepEqual([view(mac, laptop.device.id), view(mac, phone.device.id)], [true, true]);
    // The two modes that name no devices drop whatever list came with them.
    assert.deepEqual(store.getDevice(mac.device.id).visibility.deviceIds, []);
  });

  it("gives a device that joins later the default of each mode", () => {
    const mac = enroll("computer", "Mac");
    const early = enroll("computer", "Early");
    const lateSees = (mode, ids) => {
      store.setVisibility(mac.device.id, mode, ids);
      const late = enroll("computer", `Late ${mode}`);
      return view(mac, late.device.id);
    };
    assert.equal(lateSees("visible_to_all", []), true);
    assert.equal(lateSees("hidden_from_all", []), false);
    assert.equal(lateSees("hidden_from_selected", [early.device.id]), true);
    assert.equal(lateSees("visible_to_selected", [early.device.id]), false);
  });

  it("bumps the rev only when the setting changes and refuses a list naming the device itself", () => {
    const mac = enroll("computer", "Mac");
    const other = enroll("computer", "Other");
    const rev = store.rev;
    const changed = store.setVisibility(mac.device.id, "hidden_from_selected", [other.device.id]);
    assert.equal(changed, rev + 1);
    assert.equal(
      store.setVisibility(mac.device.id, "hidden_from_selected", [
        other.device.id,
        other.device.id,
      ]),
      rev + 1,
    );
    assert.equal(store.rev, rev + 1);
    assert.equal(
      code(() => store.setVisibility(mac.device.id, "hidden_from_selected", [mac.device.id])),
      "invalid_request",
    );
    assert.equal(store.setVisibility("nobody", "hidden_from_all", []), null);
  });

  it("opens a version 1 database, keeps its devices and makes them visible to everyone", () => {
    const path = join(dir, "v1.db");
    const old = new store.db.constructor(path);
    old.exec(`
      CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), registry_id TEXT NOT NULL, rev INTEGER NOT NULL);
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('computer', 'phone')), jwk TEXT NOT NULL, subdomain TEXT,
        environment_id TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER, last_sync_at INTEGER,
        last_tunnel_at INTEGER, invited_by TEXT, invite_id TEXT,
        CHECK (kind = 'computer' OR subdomain IS NULL)
      );
      INSERT INTO meta (id, registry_id, rev) VALUES (1, 'oldreg22', 7);
      INSERT INTO devices (id, name, name_key, kind, jwk, subdomain, created_at)
        VALUES ('old-mac', 'Old Mac', 'old mac', 'computer', '{}', 'old-mac', 1);
      PRAGMA user_version = 1;
    `);
    old.close();
    const upgraded = Store.open(path);
    try {
      assert.equal(upgraded.registryId, "oldreg22");
      assert.equal(upgraded.rev, 7);
      assert.deepEqual(upgraded.getDevice("old-mac").visibility, {
        mode: "visible_to_all",
        deviceIds: [],
      });
      assert.equal(upgraded.setVisibility("old-mac", "hidden_from_all", []), 8);
      assert.equal(upgraded.db.prepare("PRAGMA user_version").get().user_version, 2);
    } finally {
      upgraded.close();
    }
    // Opening it again is a no-op.
    const again = Store.open(path);
    assert.equal(again.getDevice("old-mac").visibility.mode, "hidden_from_all");
    again.close();
  });

  it("repairs a database whose migration stopped after the first column", () => {
    const path = join(dir, "half.db");
    const old = new store.db.constructor(path);
    old.exec(`
      CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), registry_id TEXT NOT NULL, rev INTEGER NOT NULL);
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('computer', 'phone')), jwk TEXT NOT NULL, subdomain TEXT,
        environment_id TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER, last_sync_at INTEGER,
        last_tunnel_at INTEGER, invited_by TEXT, invite_id TEXT,
        visibility_mode TEXT NOT NULL DEFAULT 'visible_to_all'
          CHECK (visibility_mode IN ('visible_to_all', 'hidden_from_all', 'hidden_from_selected', 'visible_to_selected')),
        CHECK (kind = 'computer' OR subdomain IS NULL)
      );
      INSERT INTO meta (id, registry_id, rev) VALUES (1, 'halfreg2', 3);
      INSERT INTO devices (id, name, name_key, kind, jwk, subdomain, created_at, visibility_mode)
        VALUES ('half-mac', 'Half Mac', 'half mac', 'computer', '{}', 'half-mac', 1, 'hidden_from_all');
      PRAGMA user_version = 1;
    `);
    old.close();
    const repaired = Store.open(path);
    try {
      assert.deepEqual(repaired.getDevice("half-mac").visibility, {
        mode: "hidden_from_all",
        deviceIds: [],
      });
      assert.equal(repaired.db.prepare("PRAGMA user_version").get().user_version, 2);
    } finally {
      repaired.close();
    }
  });
});
