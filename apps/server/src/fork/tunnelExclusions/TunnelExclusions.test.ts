import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessInspector from "./ProcessInspector.ts";
import * as TerminalShellRegistry from "./TerminalShellRegistry.ts";
import * as TunnelExclusions from "./TunnelExclusions.ts";

const SERVER = 100;
const rows: ReadonlyArray<ProcessInspector.ProcessRow> = [
  { pid: 1, ppid: 0, args: "/sbin/launchd", startTime: "s1" },
  { pid: SERVER, ppid: 1, args: "node server.mjs", startTime: "s100" },
  // `nohup uv run board serve --port 7733 &`: its script exited, launchd adopted it.
  { pid: 520, ppid: 1, args: "python3 -m board serve --port 7733", startTime: "s520" },
  { pid: 530, ppid: 1, args: "node app.js --inspect=9230", startTime: "s530" },
];
const LISTENERS: Readonly<Record<number, number>> = { 7733: 520, 3000: 530, 3773: SERVER };

const setup = (options: { readonly platform?: NodeJS.Platform; readonly fail?: boolean } = {}) => {
  const reads = { listeners: 0 };
  const inspector = Layer.mock(ProcessInspector.ProcessInspector, {
    table: Effect.succeed(new Map(rows.map((row) => [row.pid, row]))),
    listeners: (ports) =>
      Effect.suspend(() => {
        reads.listeners += 1;
        if (options.fail)
          return Effect.fail(new ProcessInspector.ProcessInspectError({ reason: "ps timed out" }));
        return Effect.succeed(
          ports.map((port) =>
            LISTENERS[port] === undefined
              ? []
              : [{ pid: LISTENERS[port], address: "127.0.0.1", family: "IPv4" as const }],
          ),
        );
      }),
    launchText: (pid) => Effect.succeed(rows.find((row) => row.pid === pid)?.args ?? null),
  });
  const layer = Layer.effect(
    TunnelExclusions.TunnelExclusions,
    TunnelExclusions.make({ serverPid: SERVER }),
  ).pipe(
    Layer.provide(inspector),
    Layer.provide(
      Layer.succeed(TerminalShellRegistry.TerminalShellRegistry, {
        shells: Effect.succeed(new Map()),
      }),
    ),
    Layer.provide(
      Layer.succeed(TunnelExclusions.ConfiguredExecutables, { read: Effect.succeed([]) }),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
  );
  return { reads, layer };
};

const check = (port: number) =>
  TunnelExclusions.TunnelExclusions.pipe(Effect.flatMap((exclusions) => exclusions.check(port)));

it.effect(
  "forwards a detached service and refuses debuggers, this server and blocked ports",
  () => {
    const { reads, layer } = setup();
    return Effect.gen(function* () {
      assert.isNull(yield* check(7733));
      assert.deepEqual(yield* check(3000), { code: "debug-process" });
      assert.deepEqual(yield* check(3773), { code: "reserved" });
      assert.isNull(yield* check(4000));
      const before = reads.listeners;
      assert.deepEqual(yield* check(9229), { code: "reserved" });
      assert.equal(reads.listeners, before);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("shares one read among a page's connections, and reads again after the TTL", () => {
  const { reads, layer } = setup();
  return Effect.gen(function* () {
    const verdicts = yield* Effect.all([check(7733), check(7733), check(7733)], {
      concurrency: "unbounded",
    });
    assert.deepEqual(verdicts, [null, null, null]);
    assert.equal(reads.listeners, 1);
    yield* TestClock.adjust(TunnelExclusions.VERDICT_TTL_MS);
    yield* check(7733);
    assert.equal(reads.listeners, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses when the process table cannot be read", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* check(7733), { code: "unverified" });
  }).pipe(Effect.provide(setup({ fail: true }).layer)),
);

it.effect("checks only the blocked ports where processes cannot be read", () => {
  const { reads, layer } = setup({ platform: "win32" });
  return Effect.gen(function* () {
    assert.isNull(yield* check(3000));
    assert.deepEqual(yield* check(9222), { code: "reserved" });
    assert.equal(reads.listeners, 0);
  }).pipe(Effect.provide(layer));
});
