// `t3x devices` as a process on a temp home: the state directory is opened in-process, no server runs.
// @effect-diagnostics nodeBuiltinImport:off -- Subprocess and the files it leaves behind.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { homeDir, seedHome } from "./homeSeed.testkit.ts";

const ENTRY = NodePath.resolve(import.meta.dirname, "../../bin.ts");
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** The device key, membership and list under the home's userdata, with their bytes, so "changed nothing" can be asserted. */
const snapshotOf = (baseDir: string) => {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith("fork-device-"))
        files[NodePath.relative(baseDir, full)] = NodeFS.readFileSync(full, "base64");
    }
  };
  walk(NodePath.join(baseDir, "userdata"));
  return files;
};

/** A registry that, if anyone asks it, says this computer is unknown. Every ask is written to `log`. */
const registrySpy = (baseDir: string) => {
  const log = NodePath.join(baseDir, "registry-asks.log");
  const preload = NodePath.join(baseDir, "registry-spy.mjs");
  NodeFS.writeFileSync(
    preload,
    [
      'import { appendFileSync } from "node:fs";',
      "globalThis.fetch = async (input) => {",
      "  appendFileSync(process.env.REGISTRY_ASKS_LOG, String(input?.url ?? input) + '\\n');",
      "  return new Response(JSON.stringify({ error: 'device_unknown' }), { status: 401, headers: { 'content-type': 'application/json' } });",
      "};",
    ].join("\n"),
  );
  return {
    env: { NODE_OPTIONS: `--import ${preload}`, REGISTRY_ASKS_LOG: log },
    asks: () =>
      NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
  };
};

/** A registry nobody can reach: every ask fails like a dropped connection. */
const offlineRegistry = (baseDir: string) => {
  const preload = NodePath.join(baseDir, "registry-offline.mjs");
  NodeFS.writeFileSync(
    preload,
    'globalThis.fetch = async () => { throw new TypeError("fetch failed"); };\n',
  );
  return { NODE_OPTIONS: `--import ${preload}` };
};

const run = (baseDir: string, ...args: ReadonlyArray<string>) => runWith({}, baseDir, ...args);

const runWith = (env: Record<string, string>, baseDir: string, ...args: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<{ readonly code: number | null; readonly out: string; readonly err: string }>(
        (resolve) => {
          NodeChildProcess.execFile(
            process.execPath,
            [ENTRY, "devices", ...args, "--base-dir", baseDir],
            { env: { ...process.env, ...env, T3CODE_HOME: baseDir } },
            (error, out, err) =>
              resolve({
                code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
                out,
                err,
              }),
          );
        },
      ),
  );

describe("t3x devices", () => {
  it.live("says so when this computer has not joined, and refuses what needs a membership", () =>
    Effect.gen(function* () {
      const baseDir = yield* homeDir;
      const listed = yield* run(baseDir, "list");
      assert.equal(listed.code, 0);
      assert.include(listed.out, "has not joined a server");
      const invited = yield* run(baseDir, "invite");
      assert.notEqual(invited.code, 0);
      assert.include(invited.err + invited.out, "has not joined a server");
      const left = yield* run(baseDir, "leave");
      assert.notEqual(left.code, 0);
    }).pipe(Effect.scoped),
  );

  it.live("lists a joined home, as JSON too, and refuses to remove what it cannot name", () =>
    Effect.gen(function* () {
      const baseDir = yield* homeDir;
      const seeded = yield* seedHome(baseDir);
      const listed = yield* run(baseDir, "list");
      assert.equal(listed.code, 0, listed.err);
      assert.include(listed.out, "Studio (this computer)");
      assert.include(listed.out, "Laptop");
      assert.match(listed.out, /^Last synced with your server \S+\.$/m);
      assert.notInclude(listed.out, "minutes ago");
      const json = decodeJson((yield* run(baseDir, "list", "--json")).out) as {
        readonly self: string;
        readonly fetchedAt: number | null;
        readonly staleness: string;
        readonly devices: ReadonlyArray<{ readonly name: string }>;
      };
      assert.equal(json.devices.length, 2);
      assert.isString(json.self);
      assert.isNumber(json.fetchedAt);
      assert.equal(json.staleness, "fresh");
      assert.notProperty(json, "synced");
      assert.include(seeded.tunnelOrigin, "studio");

      const missing = yield* run(baseDir, "remove", "Nobody");
      assert.notEqual(missing.code, 0);
      assert.include(missing.err + missing.out, "No device named Nobody");
    }).pipe(Effect.scoped),
  );

  it.live(
    "list is read-only: it never asks the registry, and a registry that disowns it changes nothing",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* homeDir;
        yield* seedHome(baseDir);
        const spy = registrySpy(baseDir);
        const before = snapshotOf(baseDir);
        assert.isAbove(Object.keys(before).length, 0);

        for (const args of [["list"], ["list", "--json"]]) {
          const listed = yield* runWith(spy.env, baseDir, ...args);
          assert.equal(listed.code, 0, listed.err);
          assert.include(listed.out, "Laptop");
        }
        assert.deepEqual(spy.asks(), []);
        assert.deepEqual(snapshotOf(baseDir), before);

        // Control: the spy does see a command that does talk to the registry.
        yield* runWith(spy.env, baseDir, "invite");
        assert.isAbove(spy.asks().length, 0);
      }).pipe(Effect.scoped),
  );

  it.live("list says how long ago the last sync was once that is over three minutes", () =>
    Effect.gen(function* () {
      const baseDir = yield* homeDir;
      yield* seedHome(baseDir);
      const listFile = NodePath.join(baseDir, "userdata", "secrets", "fork-device-list.bin");
      const stored = decodeJson(NodeFS.readFileSync(listFile, "utf8")) as { fetchedAt: number };
      const ageAndList = (seconds: number) => {
        NodeFS.writeFileSync(
          listFile,
          JSON.stringify({ ...stored, fetchedAt: stored.fetchedAt - seconds }),
        );
        return run(baseDir, "list");
      };
      const edge = yield* ageAndList(120);
      assert.notInclude(edge.out, "minutes ago");
      const stale = yield* ageAndList(600);
      assert.include(stale.out, "10 minutes ago");
      assert.include(stale.out, "T3 may not be running on this computer");
      assert.include(stale.out, "t3x devices tunnel status");
    }).pipe(Effect.scoped),
  );

  it.live("refuses an invite that is not an invite", () =>
    Effect.gen(function* () {
      const baseDir = yield* homeDir;
      const joined = yield* run(baseDir, "join", "t3x1.not-an-invite");
      assert.notEqual(joined.code, 0);
      assert.include(joined.err + joined.out, "not valid for a computer");
      // One line on stderr, not a logged stack trace.
      assert.equal(joined.err.trim().split("\n").length, 1, joined.err);
    }).pipe(Effect.scoped),
  );

  it.live(
    "visibility saves the choice on this computer, shows it, and refuses what it cannot name",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* homeDir;
        yield* seedHome(baseDir);
        const offline = offlineRegistry(baseDir);
        const visibility = (...args: ReadonlyArray<string>) =>
          runWith(offline, baseDir, "visibility", ...args);
        const savedMode = () =>
          (
            decodeJson(
              NodeFS.readFileSync(
                NodePath.join(baseDir, "userdata", "secrets", "fork-device-visibility.bin"),
                "utf8",
              ),
            ) as { visibility: { mode: string } }
          ).visibility.mode;

        const initial = yield* visibility("show");
        assert.equal(initial.code, 0, initial.err);
        assert.include(initial.out, "Visible to all devices.");

        const none = yield* visibility("none");
        assert.equal(none.code, 0, none.err);
        assert.include(none.out, "Hidden from all devices.");
        // The server cannot be reached here: the choice is saved and applied, and the report says so.
        assert.include(none.out, "has not received this setting yet");
        assert.equal(savedMode(), "hidden_from_all");

        // A later process reads what the earlier one learned instead of starting from "not known".
        const later = yield* visibility("show");
        assert.include(later.out, "has not received this setting yet");
        assert.notInclude(later.out, "not known yet");

        const hide = yield* visibility("hide", "laptop");
        assert.equal(hide.code, 0, hide.err);
        assert.include(hide.out, "Hidden from: Laptop.");
        const only = yield* visibility("only", "Laptop", "--json");
        assert.equal(only.code, 0, only.err);
        const json = decodeJson(only.out) as { mode: string; deviceIds: ReadonlyArray<string> };
        assert.equal(json.mode, "visible_to_selected");
        assert.equal(json.deviceIds.length, 1);
        assert.equal((yield* visibility("show")).out.includes("Visible only to: Laptop."), true);

        const missing = yield* visibility("hide", "Nobody");
        assert.notEqual(missing.code, 0);
        assert.include(missing.err + missing.out, "No device named Nobody");
        const own = yield* visibility("hide", "Studio");
        assert.notEqual(own.code, 0);
        assert.include(own.err + own.out, "cannot be in its own list");
        assert.equal(savedMode(), "visible_to_selected");

        // A file that cannot be read is said so, not reported as "hidden from all".
        const file = NodePath.join(baseDir, "userdata", "secrets", "fork-device-visibility.bin");
        const good = NodeFS.readFileSync(file);
        NodeFS.writeFileSync(file, "{not json");
        const unreadable = yield* visibility("show");
        assert.equal(unreadable.code, 0, unreadable.err);
        assert.include(unreadable.out, "could not be read");
        assert.notInclude(unreadable.out, "Hidden from all devices");
        NodeFS.writeFileSync(file, good);

        assert.equal((yield* visibility("all")).code, 0);
        assert.equal(savedMode(), "visible_to_all");
      }).pipe(Effect.scoped),
  );

  it.live("visibility needs a joined computer", () =>
    Effect.gen(function* () {
      const baseDir = yield* homeDir;
      const result = yield* run(baseDir, "visibility", "none");
      assert.notEqual(result.code, 0);
      assert.include(result.err + result.out, "has not joined a server");
    }).pipe(Effect.scoped),
  );
});
