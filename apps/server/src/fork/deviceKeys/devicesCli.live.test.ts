// `t3x devices` as a process on a temp home: the state directory is opened in-process, no server runs.
// @effect-diagnostics nodeBuiltinImport:off -- Subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { homeDir, seedHome } from "./homeSeed.testkit.ts";

const ENTRY = NodePath.resolve(import.meta.dirname, "../../bin.ts");
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const run = (baseDir: string, ...args: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<{ readonly code: number | null; readonly out: string; readonly err: string }>(
        (resolve) => {
          NodeChildProcess.execFile(
            process.execPath,
            [ENTRY, "devices", ...args, "--base-dir", baseDir],
            { env: { ...process.env, T3CODE_HOME: baseDir } },
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
      // The seeded server does not exist: the list says so and from when it dates.
      assert.include(listed.out, "could not be reached");
      assert.include(listed.out, "last successful sync");
      const json = decodeJson((yield* run(baseDir, "list", "--json")).out) as {
        readonly self: string;
        readonly fetchedAt: number | null;
        readonly synced: boolean;
        readonly devices: ReadonlyArray<{ readonly name: string }>;
      };
      assert.equal(json.devices.length, 2);
      assert.isString(json.self);
      assert.isNumber(json.fetchedAt);
      assert.isFalse(json.synced);
      assert.include(seeded.tunnelOrigin, "studio");

      const missing = yield* run(baseDir, "remove", "Nobody");
      assert.notEqual(missing.code, 0);
      assert.include(missing.err + missing.out, "No device named Nobody");
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
});
