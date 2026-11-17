// Tunnels that arrive together are checked from one set of reads, and only those: a read that began
// before a tunnel arrived is never used for it, and nothing outlives its batch (design 5.3). The
// inspector is a fake over a made-up process table; `TestClock` closes the collection window.
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as PortScanner from "../../preview/PortScanner.ts";
import {
  COLLECT_WINDOW_MS,
  ConfiguredExecutables,
  make as makeAuthorizer,
  type GatewayRefusal,
} from "./PortAuthorizer.ts";
import { memoryGrants } from "./grants.testkit.ts";
import { LoopbackGatewayGrants } from "./LoopbackGatewayGrants.ts";
import * as ProcessInspector from "./ProcessInspector.ts";
import * as TerminalShellRegistry from "./TerminalShellRegistry.ts";

const SERVER = 100;
const SHELL = 200;
const START = "Mon Jan 1 00:00:00 2026";

const row = (pid: number, ppid: number, args: string): ProcessInspector.ProcessRow => ({
  pid,
  ppid,
  startTime: `${START} ${pid}`,
  args,
});

/** pid 300+n is a job of the terminal shell listening on port 5000+n; 400 is a stray child of the server. */
const jobPid = (n: number) => 300 + n;
const jobPort = (n: number) => 5000 + n;

interface World {
  /** Which job numbers are alive and listening. */
  alive: Set<number>;
  strayAlive: boolean;
}

const tableOf = (world: World): ProcessInspector.ProcessTable => {
  const rows = [row(SERVER, 1, "t3 server"), row(SHELL, SERVER, "/bin/zsh")];
  for (const n of world.alive) rows.push(row(jobPid(n), SHELL, `node dev-${n}.js`));
  if (world.strayAlive) rows.push(row(400, SERVER, "some-daemon"));
  return new Map(rows.map((r) => [r.pid, r]));
};

const entriesOn = (world: World, port: number) => {
  const found: Array<ProcessInspector.ListenerEntry> = [];
  for (const n of world.alive) {
    // Job 3 listens on a LAN address only.
    if (jobPort(n) === port) {
      found.push({
        pid: jobPid(n),
        address: n === 3 ? "192.168.1.5" : "127.0.0.1",
        family: "IPv4",
      });
    }
  }
  if (world.strayAlive && port === 5400) {
    found.push({ pid: 400, address: "127.0.0.1", family: "IPv4" });
  }
  return found;
};

interface Calls {
  table: number;
  listeners: Array<ReadonlyArray<number>>;
  listenersOf: Array<ReadonlyArray<{ pid: number; port: number }>>;
  launch: Array<number>;
  startTime: Array<number>;
}

const makeRig = Effect.gen(function* () {
  const world: World = { alive: new Set([1, 2]), strayAlive: true };
  const calls: Calls = { table: 0, listeners: [], listenersOf: [], launch: [], startTime: [] };
  const hooks = {
    /** Runs when a table read starts; a test blocks here to hold a batch in the middle. */
    onTable: (_call: number): Effect.Effect<void> => Effect.void,
    failTable: false,
  };
  const nominated = { count: 0, expect: 0, latch: yield* Deferred.make<void>() };
  const inspector = ProcessInspector.ProcessInspector.of({
    table: Effect.suspend(() => {
      calls.table += 1;
      const call = calls.table;
      if (hooks.failTable) {
        return Effect.fail(new ProcessInspector.ProcessInspectError({ reason: "ps failed" }));
      }
      return hooks.onTable(call).pipe(Effect.map(() => tableOf(world)));
    }),
    startTime: (pid) =>
      Effect.sync(() => {
        calls.startTime.push(pid);
        return tableOf(world).get(pid)?.startTime ?? null;
      }),
    launchText: (pid) =>
      Effect.sync(() => {
        calls.launch.push(pid);
        return tableOf(world).has(pid) ? `${tableOf(world).get(pid)!.args} HOME=/x` : null;
      }),
    listeners: (ports) =>
      Effect.sync(() => {
        calls.listeners.push(ports);
        return ports.map((port) => entriesOn(world, port));
      }),
    listenersOf: (pairs) =>
      Effect.sync(() => {
        calls.listenersOf.push(pairs);
        return pairs.map(({ pid, port }) =>
          entriesOn(world, port).filter((entry) => entry.pid === pid),
        );
      }),
  });
  const discovery = PortScanner.PortDiscovery.of({
    scan: () => Effect.succeed([] as never),
    scanBackground: () =>
      Effect.sync(() => {
        nominated.count += 1;
        // After this fiber has run on to join the batch, not before: waking the test fiber here
        // could run it first.
        if (nominated.count === nominated.expect) {
          const latch = nominated.latch;
          queueMicrotask(() => Deferred.doneUnsafe(latch, Effect.void));
        }
        // The nomination is the same for every call; the reads decide.
        return [1, 2, 3]
          .map((n) => ({ port: jobPort(n), pid: jobPid(n) }))
          .concat([{ port: 5400, pid: 400 }]) as never;
      }),
  } as never);
  const authorizer = yield* makeAuthorizer({
    serverPid: SERVER,
    reservedPorts: Effect.succeed(new Set<number>()),
  }).pipe(
    Effect.provideService(ProcessInspector.ProcessInspector, inspector),
    Effect.provideService(PortScanner.PortDiscovery, discovery),
    Effect.provideService(TerminalShellRegistry.TerminalShellRegistry, {
      shells: Effect.succeed(new Map([[SHELL, { startTime: `${START} ${SHELL}` }]])),
    }),
    Effect.provideService(ConfiguredExecutables, { read: Effect.succeed([]) }),
    Effect.provideService(LoopbackGatewayGrants, memoryGrants()),
  );
  /** Starts `ports.length` tunnels at once and resolves once each has joined the collection window. */
  const arrive = Effect.fn("arrive")(function* (ports: ReadonlyArray<number>) {
    nominated.count = 0;
    nominated.expect = ports.length;
    nominated.latch = yield* Deferred.make<void>();
    const fibers = yield* Effect.forEach(ports, (port) =>
      Effect.forkChild(Effect.result(authorizer.authorize(port))),
    );
    yield* Deferred.await(nominated.latch);
    return fibers;
  });
  const closeWindow = TestClock.adjust(Duration.millis(COLLECT_WINDOW_MS));
  return { world, calls, hooks, authorizer, arrive, closeWindow };
});

const verdict = (result: {
  readonly _tag: "Success" | "Failure";
  readonly success?: unknown;
  readonly failure?: unknown;
}) => (result._tag === "Success" ? "allowed" : (result.failure as GatewayRefusal).code);

describe("batched verification", () => {
  it.effect("tunnels that arrive together share one set of reads and are each judged alone", () =>
    Effect.gen(function* () {
      const x = yield* makeRig;
      // Six tunnels to one port, one to another, one to a stray child of the server.
      const fibers = yield* x.arrive([5001, 5001, 5001, 5001, 5001, 5001, 5002, 5400]);
      yield* x.closeWindow;
      const results = yield* Effect.forEach(fibers, Fiber.join);
      assert.deepEqual(results.map(verdict), [
        "allowed",
        "allowed",
        "allowed",
        "allowed",
        "allowed",
        "allowed",
        "allowed",
        "reserved",
      ]);
      assert.equal(x.calls.table, 1);
      assert.deepEqual(x.calls.listeners, [[5001, 5002, 5400]]);
      assert.deepEqual(x.calls.launch.toSorted(), [301, 302, 400]);
      // The stray child is refused before the second round of reads.
      assert.equal(x.calls.listenersOf.length, 1);
      assert.equal(x.calls.listenersOf[0]!.length, 7);
      assert.deepEqual(x.calls.startTime.toSorted(), [301, 302]);
    }).pipe(Effect.scoped),
  );

  it.effect("a service that listens on no loopback address is not-loopback, not not-owned", () =>
    Effect.gen(function* () {
      const x = yield* makeRig;
      x.world.alive.add(3);
      const [fiber] = yield* x.arrive([5003]);
      yield* x.closeWindow;
      assert.equal(verdict(yield* Fiber.join(fiber!)), "not-loopback");
    }).pipe(Effect.scoped),
  );

  it.effect("six tunnels one after another are six batches: nothing is kept between them", () =>
    Effect.gen(function* () {
      const x = yield* makeRig;
      for (let i = 0; i < 6; i++) {
        const [fiber] = yield* x.arrive([5001]);
        yield* x.closeWindow;
        assert.equal(verdict(yield* Fiber.join(fiber!)), "allowed");
      }
      assert.equal(x.calls.table, 6);
      assert.equal(x.calls.listeners.length, 6);
      assert.equal(x.calls.listenersOf.length, 6);
      assert.equal(x.calls.launch.length, 6);
      assert.equal(x.calls.startTime.length, 6);
    }).pipe(Effect.scoped),
  );

  it.effect("a tunnel that arrives after the reads began is never answered from them", () =>
    Effect.gen(function* () {
      const x = yield* makeRig;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      x.hooks.onTable = (call) => {
        if (call === 1) {
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)));
        }
        // The second batch's reads find the job gone.
        x.world.alive.delete(1);
        return Effect.void;
      };
      const [first] = yield* x.arrive([5001]);
      yield* x.closeWindow;
      yield* Deferred.await(started);
      // A second tunnel for the same port arrives while the first batch's reads are in flight.
      const [second] = yield* x.arrive([5001]);
      yield* Deferred.succeed(release, undefined);
      // The first batch answers from what it read. The second is checked by reads that began
      // after it arrived, so it sees the job gone, and it waited for no new window.
      assert.equal(verdict(yield* Fiber.join(first!)), "allowed");
      assert.equal(verdict(yield* Fiber.join(second!)), "owner-changed");
      assert.equal(x.calls.table, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("a tunnel that gives up while it waits leaves the batch to the others", () =>
    Effect.gen(function* () {
      const x = yield* makeRig;
      const [leaves, stays] = yield* x.arrive([5001, 5002]);
      yield* Fiber.interrupt(leaves!);
      yield* x.closeWindow;
      assert.equal(verdict(yield* Fiber.join(stays!)), "allowed");
      assert.deepEqual(x.calls.listeners, [[5002]]);
      assert.deepEqual(x.calls.launch, [302]);
    }).pipe(Effect.scoped),
  );

  it.effect("a batch nobody waits for any more reads nothing", () =>
    Effect.gen(function* () {
      const x = yield* makeRig;
      const [only] = yield* x.arrive([5001]);
      yield* Fiber.interrupt(only!);
      yield* x.closeWindow;
      assert.equal(x.calls.table, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("a failed read fails every tunnel of its batch, and the next batch starts clean", () =>
    Effect.gen(function* () {
      const x = yield* makeRig;
      x.hooks.failTable = true;
      const fibers = yield* x.arrive([5001, 5002]);
      yield* x.closeWindow;
      const failed = yield* Effect.forEach(fibers, Fiber.join);
      assert.deepEqual(failed.map(verdict), ["owner-changed", "owner-changed"]);
      x.hooks.failTable = false;
      const [again] = yield* x.arrive([5001]);
      yield* x.closeWindow;
      assert.equal(verdict(yield* Fiber.join(again!)), "allowed");
    }).pipe(Effect.scoped),
  );
});
