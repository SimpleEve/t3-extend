// The ports the user allowed by hand: what is kept, what is refused, and what a bad file means.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { LoopbackGatewayAllowedPortError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import {
  LOOPBACK_GATEWAY_MAX_ALLOWED_PORTS,
  make,
  type LoopbackGatewayGrantsOptions,
} from "./LoopbackGatewayGrants.ts";

const SERVER_PORT = 1234;

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gateway-grants-" });
  const file = path.join(directory, "allowed.json");
  const options: LoopbackGatewayGrantsOptions = {
    file,
    reservedPorts: Effect.succeed(new Set([SERVER_PORT])),
  };
  return { fs, path, directory, file, options, open: make(options) };
});

const portsOf = (list: ReadonlyArray<{ readonly port: number }>) => list.map((entry) => entry.port);

describe("allowed ports", () => {
  it.effect("keeps them in order, across a restart, and takes one away again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const x = yield* setup;
        const grants = yield* x.open;
        assert.deepEqual(yield* grants.list, []);
        yield* grants.allow(7733);
        const second = yield* grants.allow(8080);
        assert.deepEqual(portsOf(second), [7733, 8080]);
        assert.deepEqual(JSON.parse(yield* x.fs.readFileString(x.file)).version, 1);

        const reopened = yield* x.open;
        assert.deepEqual(yield* reopened.list, second);
        assert.equal(DateTime.isDateTime((yield* reopened.list)[0]!.allowedAt), true);
        assert.deepEqual(portsOf(yield* reopened.remove(7733)), [8080]);
        assert.deepEqual(portsOf(yield* (yield* x.open).list), [8080]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("allowing twice or removing what is not there changes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const x = yield* setup;
        const grants = yield* x.open;
        const first = yield* grants.allow(7733);
        const again = yield* grants.allow(7733);
        assert.deepEqual(again, first);
        assert.deepEqual(yield* grants.remove(9999), first);
        assert.equal(
          DateTime.toEpochMillis(again[0]!.allowedAt),
          DateTime.toEpochMillis(first[0]!.allowedAt),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect.each([
    [0, "invalid-port"],
    [65536, "invalid-port"],
    [-1, "invalid-port"],
    [80.5, "invalid-port"],
    [9222, "reserved"],
    [2375, "reserved"],
    [SERVER_PORT, "reserved"],
  ] as const)("refuses port %s: %s", ([port, reason]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const x = yield* setup;
        const grants = yield* x.open;
        const error = yield* grants.allow(port).pipe(Effect.flip);
        assert.instanceOf(error, LoopbackGatewayAllowedPortError);
        assert.equal(error.reason, reason);
        assert.deepEqual(yield* grants.list, []);
        assert.equal(yield* x.fs.exists(x.file), false);
        // Removing is checked for the shape of the port too.
        if (reason === "invalid-port") {
          assert.equal((yield* grants.remove(port).pipe(Effect.flip)).reason, "invalid-port");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("holds at most 64 and has room again once one is removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const x = yield* setup;
        const grants = yield* x.open;
        for (let port = 20_000; port < 20_000 + LOOPBACK_GATEWAY_MAX_ALLOWED_PORTS; port++) {
          yield* grants.allow(port);
        }
        const error = yield* grants.allow(30_000).pipe(Effect.flip);
        assert.equal(error.reason, "limit-reached");
        assert.equal((yield* grants.list).length, LOOPBACK_GATEWAY_MAX_ALLOWED_PORTS);
        yield* grants.remove(20_000);
        assert.equal((yield* grants.allow(30_000)).length, LOOPBACK_GATEWAY_MAX_ALLOWED_PORTS);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect.each([
    ["not json", "{"],
    ["a different version", JSON.stringify({ version: 2, ports: [] })],
    [
      "a port out of range",
      JSON.stringify({ version: 1, ports: [{ port: 0, allowedAt: "2026-11-01T00:00:00.000Z" }] }),
    ],
    [
      "more than the limit",
      JSON.stringify({
        version: 1,
        ports: Array.from({ length: LOOPBACK_GATEWAY_MAX_ALLOWED_PORTS + 1 }, (_, index) => ({
          port: 20_000 + index,
          allowedAt: "2026-11-01T00:00:00.000Z",
        })),
      }),
    ],
  ] as const)(
    "reads a file that is %s as an empty list, with a warning, and replaces it on the next change",
    ([, content]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const warnings: Array<string> = [];
          const x = yield* setup;
          yield* x.fs.writeFileString(x.file, content);
          const grants = yield* x.open.pipe(
            Effect.provide(
              Logger.layer([
                Logger.make((entry) => {
                  if (entry.logLevel === "Warn") warnings.push(String(entry.message));
                }),
              ]),
            ),
          );
          assert.deepEqual(yield* grants.list, []);
          assert.equal(warnings.length, 1);
          assert.deepEqual(portsOf(yield* grants.allow(7733)), [7733]);
          assert.deepEqual(portsOf(yield* (yield* x.open).list), [7733]);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("keeps the list as it was when it cannot be saved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const x = yield* setup;
        // The parent of the file is a regular file, so the directory cannot be made.
        const blocker = x.path.join(x.directory, "blocker");
        yield* x.fs.writeFileString(blocker, "");
        const grants = yield* make({
          ...x.options,
          file: x.path.join(blocker, "allowed.json"),
        });
        const error = yield* grants.allow(7733).pipe(Effect.flip);
        assert.equal(error.reason, "not-saved");
        assert.deepEqual(yield* grants.list, []);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
