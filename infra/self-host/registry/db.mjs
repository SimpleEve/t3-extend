// The registry's SQLite store (node:sqlite, WAL). Spec: research/self-host-device-keys.md Q5 and 3.12 C.
// Every write transaction is BEGIN IMMEDIATE with busy_timeout 200 ms. The plugin and `ask` paths only read.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import { b64u } from "./proof.mjs";
import { allocateSubdomain, nameCandidates, nameKey, randomBase32 } from "./subdomain.mjs";

const { createHash, randomBytes, timingSafeEqual } = NodeCrypto;
const { DatabaseSync } = NodeSqlite;

export const SCHEMA_VERSION = 2;
export const VISIBILITY_MODES = [
  "visible_to_all",
  "hidden_from_all",
  "hidden_from_selected",
  "visible_to_selected",
];
export const DEFAULT_VISIBILITY = Object.freeze({ mode: "visible_to_all", deviceIds: [] });
/** A request body is at most 4096 bytes and a device id is 43 characters. */
export const MAX_VISIBILITY_DEVICES = 64;
export const INVITE_TTL_SECONDS = 15 * 60;
export const MAX_OPEN_INVITES = 20;
const INVITE_RETENTION_SECONDS = 24 * 60 * 60;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registry_id TEXT NOT NULL,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('computer', 'phone')),
  jwk TEXT NOT NULL,
  subdomain TEXT,
  environment_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_sync_at INTEGER,
  last_tunnel_at INTEGER,
  invited_by TEXT,
  invite_id TEXT,
  visibility_mode TEXT NOT NULL DEFAULT 'visible_to_all'
    CHECK (visibility_mode IN ('visible_to_all', 'hidden_from_all', 'hidden_from_selected', 'visible_to_selected')),
  visibility_ids TEXT NOT NULL DEFAULT '[]',
  CHECK (kind = 'computer' OR subdomain IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_name_key ON devices (name_key);
CREATE UNIQUE INDEX IF NOT EXISTS devices_subdomain ON devices (subdomain) WHERE subdomain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS devices_invite_id ON devices (invite_id) WHERE invite_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('computer', 'phone', 'any')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);
CREATE TABLE IF NOT EXISTS seen_jti (
  device_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  exp INTEGER NOT NULL,
  PRIMARY KEY (device_id, jti)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS seen_jti_exp ON seen_jti (exp);
CREATE TABLE IF NOT EXISTS tombstones (
  subdomain TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  removed_at INTEGER NOT NULL
);
`;

/** A refusal the caller maps to an HTTP error. Thrown inside a transaction so it rolls back. */
export class StoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "StoreError";
    this.code = code;
  }
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const hashSecret = (secret) => createHash("sha256").update(secret).digest("hex");

function sameHash(storedHex, candidateHex) {
  const a = Buffer.from(storedHex, "hex");
  const b = Buffer.from(candidateHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SQLITE_CONSTRAINT (19) and its extended codes. */
export function constraintMessage(error) {
  if (
    typeof error?.errcode === "number"
      ? (error.errcode & 0xff) === 19
      : /constraint failed/.test(error?.message ?? "")
  ) {
    return String(error.message);
  }
  return null;
}

/**
 * Whether `viewerId` may see `owner`. A device always sees itself, and phones have no visibility
 * setting (they are not environments), so only a computer's own choice can hide it.
 */
export function isVisibleTo(owner, viewerId) {
  if (owner.id === viewerId || owner.kind !== "computer") return true;
  const { mode, deviceIds } = owner.visibility;
  switch (mode) {
    case "hidden_from_all":
      return false;
    case "hidden_from_selected":
      return !deviceIds.includes(viewerId);
    case "visible_to_selected":
      return deviceIds.includes(viewerId);
    default:
      return true;
  }
}

/** Canonical form: unique, sorted, and empty for the two modes that do not name devices. */
export function normalizeVisibility(mode, deviceIds) {
  const selected = mode === "hidden_from_selected" || mode === "visible_to_selected";
  return { mode, deviceIds: selected ? [...new Set(deviceIds)].sort() : [] };
}

function rowToDevice(row) {
  if (row === undefined) return null;
  return {
    id: row.id,
    name: row.name,
    nameKey: row.name_key,
    kind: row.kind,
    jwk: JSON.parse(row.jwk),
    subdomain: row.subdomain ?? null,
    environmentId: row.environment_id ?? null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? null,
    lastSyncAt: row.last_sync_at ?? null,
    lastTunnelAt: row.last_tunnel_at ?? null,
    invitedBy: row.invited_by ?? null,
    inviteId: row.invite_id ?? null,
    visibility: normalizeVisibility(row.visibility_mode, JSON.parse(row.visibility_ids)),
  };
}

/**
 * Adds what a version 1 database lacks, one column at a time inside one transaction, so a run that
 * stopped half way is repaired instead of skipped. Safe to run on a database that already has it.
 */
function migrate(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const have = new Set(
      db
        .prepare("PRAGMA table_info(devices)")
        .all()
        .map((column) => column.name),
    );
    if (!have.has("visibility_mode")) {
      db.exec(
        "ALTER TABLE devices ADD COLUMN visibility_mode TEXT NOT NULL DEFAULT 'visible_to_all' CHECK (visibility_mode IN ('visible_to_all', 'hidden_from_all', 'hidden_from_selected', 'visible_to_selected'))",
      );
    }
    if (!have.has("visibility_ids")) {
      db.exec("ALTER TABLE devices ADD COLUMN visibility_ids TEXT NOT NULL DEFAULT '[]'");
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite already rolled the transaction back.
    }
    throw error;
  }
}

export class Store {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
    this.statements = new Map();
    /** deviceId -> {seen?, sync?, tunnel?}; flushed every 30 s in one transaction. */
    this.touches = new Map();
  }

  static open(path) {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 200");
    const { user_version: version } = db.prepare("PRAGMA user_version").get();
    if (version > SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `registry database is schema ${version}; this build understands ${SCHEMA_VERSION}`,
      );
    }
    db.exec(SCHEMA);
    migrate(db);
    const store = new Store(db);
    store.writeTx(() => {
      store
        .q("INSERT OR IGNORE INTO meta (id, registry_id, rev) VALUES (1, ?, 1)")
        .run(randomBase32(8));
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
    return store;
  }

  close() {
    this.db.close();
  }

  q(sql) {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  writeTx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction was already rolled back by SQLite.
      }
      throw error;
    }
  }

  get registryId() {
    return this.q("SELECT registry_id FROM meta WHERE id = 1").get().registry_id;
  }

  get rev() {
    return this.q("SELECT rev FROM meta WHERE id = 1").get().rev;
  }

  bumpRev() {
    this.q("UPDATE meta SET rev = rev + 1 WHERE id = 1").run();
    return this.rev;
  }

  getDevice(id) {
    return rowToDevice(this.q("SELECT * FROM devices WHERE id = ?").get(id));
  }

  getDeviceByName(name) {
    return rowToDevice(this.q("SELECT * FROM devices WHERE name_key = ?").get(nameKey(name)));
  }

  listDevices() {
    return this.q("SELECT * FROM devices ORDER BY created_at, rowid").all().map(rowToDevice);
  }

  hasRegisteredSubdomain(label) {
    return this.q("SELECT 1 AS found FROM devices WHERE subdomain = ?").get(label) !== undefined;
  }

  isSubdomainTaken(label) {
    return (
      this.hasRegisteredSubdomain(label) ||
      this.q("SELECT 1 AS found FROM tombstones WHERE subdomain = ?").get(label) !== undefined
    );
  }

  listTombstones() {
    return this.q(
      "SELECT subdomain, device_id, removed_at FROM tombstones ORDER BY removed_at, subdomain",
    ).all();
  }

  /** Unused, unexpired invites. */
  listOpenInvites(now) {
    return this.q(
      "SELECT id, kind, created_by, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at, id",
    ).all(now);
  }

  touch(deviceId, field, now) {
    const entry = this.touches.get(deviceId) ?? {};
    entry[field] = now;
    this.touches.set(deviceId, entry);
  }

  /** Stored values overlaid with whatever has not been flushed yet. */
  withTouches(device) {
    const pending = this.touches.get(device.id);
    if (pending === undefined) return device;
    return {
      ...device,
      lastSeenAt: pending.seen ?? device.lastSeenAt,
      lastSyncAt: pending.sync ?? device.lastSyncAt,
      lastTunnelAt: pending.tunnel ?? device.lastTunnelAt,
    };
  }

  flushTouches() {
    if (this.touches.size === 0) return 0;
    const batch = [...this.touches];
    this.touches.clear();
    const update = this.q(
      "UPDATE devices SET last_seen_at = COALESCE(?, last_seen_at), last_sync_at = COALESCE(?, last_sync_at), last_tunnel_at = COALESCE(?, last_tunnel_at) WHERE id = ?",
    );
    this.writeTx(() => {
      for (const [id, entry] of batch) {
        update.run(entry.seen ?? null, entry.sync ?? null, entry.tunnel ?? null, id);
      }
    });
    return batch.length;
  }

  /** True when the (device, jti) pair is new. A unique violation means replay; nothing else is swallowed. */
  recordJti(deviceId, jti, exp) {
    try {
      this.writeTx(() =>
        this.q("INSERT INTO seen_jti (device_id, jti, exp) VALUES (?, ?, ?)").run(
          deviceId,
          jti,
          exp,
        ),
      );
      return true;
    } catch (error) {
      if (constraintMessage(error) !== null) return false;
      throw error;
    }
  }

  /** Expired `seen_jti` rows and invites that expired more than a day ago. */
  purge(now) {
    return this.writeTx(() => ({
      jti: Number(this.q("DELETE FROM seen_jti WHERE exp < ?").run(now).changes),
      invites: Number(
        this.q("DELETE FROM invites WHERE expires_at < ?").run(now - INVITE_RETENTION_SECONDS)
          .changes,
      ),
    }));
  }

  /** Returns the plaintext secret once; only its SHA-256 is stored. Throws StoreError("too_many_invites"). */
  createInvite({ kind, createdBy, now }) {
    const id = b64u.encode(randomBytes(8));
    const secret = b64u.encode(randomBytes(16));
    const expiresAt = now + INVITE_TTL_SECONDS;
    this.writeTx(() => {
      const open = this.q(
        "SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND expires_at > ?",
      ).get(now).n;
      if (open >= MAX_OPEN_INVITES) throw new StoreError("too_many_invites");
      this.q(
        "INSERT INTO invites (id, secret_hash, kind, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, hashSecret(secret), kind, createdBy, now, expiresAt);
    });
    return { id, secret, expiresAt };
  }

  getInvite(id) {
    return this.q("SELECT id, created_by FROM invites WHERE id = ?").get(id) ?? null;
  }

  /** Cancels an unused invite. */
  deleteInvite(id) {
    return (
      this.writeTx(
        () => this.q("DELETE FROM invites WHERE id = ? AND used_at IS NULL").run(id).changes,
      ) === 1
    );
  }

  /**
   * Redeems an invite and registers the device in one transaction. The conditional UPDATE is the only
   * place an invite is consumed, and devices.invite_id is unique as a second line of defence.
   * Throws StoreError: invite_invalid | invite_expired | invite_used | kind_mismatch | name_taken | device_exists.
   */
  join({ inviteId, secret, device, now }) {
    const secretHash = hashSecret(secret);
    return this.writeTx(() => {
      const invite = this.q("SELECT * FROM invites WHERE id = ?").get(inviteId);
      if (invite === undefined || !sameHash(invite.secret_hash, secretHash)) {
        throw new StoreError("invite_invalid");
      }
      const consumed = this.q(
        "UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? AND secret_hash = ? AND kind IN (?, 'any')",
      ).run(now, device.id, inviteId, now, secretHash, device.kind);
      if (consumed.changes !== 1) {
        if (invite.expires_at <= now) throw new StoreError("invite_expired");
        if (invite.used_at !== null) throw new StoreError("invite_used");
        throw new StoreError("kind_mismatch");
      }

      const takenNames = this.q("SELECT 1 AS found FROM devices WHERE name_key = ?");
      let name;
      for (const candidate of nameCandidates(device.name)) {
        if (takenNames.get(nameKey(candidate)) === undefined) {
          name = candidate;
          break;
        }
      }
      if (name === undefined) throw new StoreError("name_taken");

      let subdomain = null;
      if (device.kind === "computer") {
        // Derived from the name as typed, not the " (2)"-suffixed display name, so duplicates become mac-2, not mac-2-2.
        subdomain = allocateSubdomain(device.name, (label) => this.isSubdomainTaken(label));
        if (subdomain === null) throw new StoreError("name_taken");
      }

      try {
        this.q(
          "INSERT INTO devices (id, name, name_key, kind, jwk, subdomain, environment_id, created_at, last_seen_at, invited_by, invite_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          device.id,
          name,
          nameKey(name),
          device.kind,
          JSON.stringify(device.jwk),
          subdomain,
          device.environmentId ?? null,
          now,
          now,
          invite.created_by,
          inviteId,
        );
      } catch (error) {
        const message = constraintMessage(error);
        if (message === null) throw error;
        if (message.includes("devices.id")) throw new StoreError("device_exists");
        throw new StoreError("name_taken");
      }
      const rev = this.bumpRev();
      return { device: this.getDevice(device.id), rev };
    });
  }

  /**
   * Deletes the device, tombstones its subdomain, drops its unused invites and bumps the rev.
   * Returns `{removedAt, rev, device}` or null when there is no such device.
   */
  removeDevice(id, now) {
    const result = this.writeTx(() => {
      const device = this.getDevice(id);
      if (device === null) return null;
      this.q("DELETE FROM devices WHERE id = ?").run(id);
      if (device.subdomain !== null) {
        this.q("INSERT INTO tombstones (subdomain, device_id, removed_at) VALUES (?, ?, ?)").run(
          device.subdomain,
          id,
          now,
        );
      }
      this.q("DELETE FROM invites WHERE created_by = ? AND used_at IS NULL").run(id);
      return { removedAt: now, rev: this.bumpRev(), device };
    });
    this.touches.delete(id);
    return result;
  }

  /** Throws StoreError("name_taken"). Returns the new rev, or null for an unknown device. */
  renameDevice(id, name) {
    return this.writeTx(() => {
      try {
        const { changes } = this.q("UPDATE devices SET name = ?, name_key = ? WHERE id = ?").run(
          name,
          nameKey(name),
          id,
        );
        return changes === 1 ? this.bumpRev() : null;
      } catch (error) {
        if (constraintMessage(error) !== null) throw new StoreError("name_taken");
        throw error;
      }
    });
  }

  /** Bumps the rev only when the value changes. Returns the current rev, or null for an unknown device. */
  setEnvironmentId(id, environmentId) {
    return this.writeTx(() => {
      const device = this.getDevice(id);
      if (device === null) return null;
      if (device.environmentId === environmentId) return this.rev;
      this.q("UPDATE devices SET environment_id = ? WHERE id = ?").run(environmentId, id);
      return this.bumpRev();
    });
  }

  /**
   * Sets the visibility of a computer. Returns the new rev (bumped only when the value changes), or null
   * for an unknown device. Throws StoreError("invalid_request") for a phone or a list naming the device itself.
   */
  setVisibility(id, mode, deviceIds) {
    return this.writeTx(() => {
      const device = this.getDevice(id);
      if (device === null) return null;
      if (device.kind !== "computer" || deviceIds.includes(id)) {
        throw new StoreError("invalid_request");
      }
      const next = normalizeVisibility(mode, deviceIds);
      if (
        device.visibility.mode === next.mode &&
        device.visibility.deviceIds.join() === next.deviceIds.join()
      ) {
        return this.rev;
      }
      this.q("UPDATE devices SET visibility_mode = ?, visibility_ids = ? WHERE id = ?").run(
        next.mode,
        JSON.stringify(next.deviceIds),
        id,
      );
      return this.bumpRev();
    });
  }

  /** Administrator only (`./t3x release`): makes a tombstoned subdomain assignable again. */
  releaseSubdomain(label) {
    return (
      this.writeTx(
        () => this.q("DELETE FROM tombstones WHERE subdomain = ?").run(label).changes,
      ) === 1
    );
  }
}
