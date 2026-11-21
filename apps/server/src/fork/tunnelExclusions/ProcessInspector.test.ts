// The platform readers: parsers over recorded real output (every platform runs these), and on
// macOS the live reads against real processes.
// @effect-diagnostics nodeBuiltinImport:off -- Real subprocesses and loopback sockets.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import {
  ProcessInspector,
  normalizeListenAddress,
  parseDarwinPsRows,
  parseLsofListeners,
  parseProcNetTcp,
  parseProcStat,
} from "./ProcessInspector.ts";
import {
  TestProcesses,
  realInspectorLayer,
  runsOnRealProcesses,
} from "./processFixtures.testkit.ts";

describe("macOS parsers (recorded from `ps` and `lsof`)", () => {
  // `LC_ALL=C TZ=UTC /bin/ps -ww -o pid=,ppid=,lstart=,args=`
  const PS = [
    "91841 91836 Wed Nov  4 13:25:23 2026     node /tmp/t3x-p91/listen.cjs 127.0.0.1 45611",
    "    1     0 Wed Sep  2 00:32:20 2026     /sbin/launchd",
    "garbage line",
    "91843 91836 Wed Nov  4 13:25:23 2026     node /tmp/with space/listen.cjs * 45613",
  ].join("\n");

  it("reads pid, parent, start time and the whole argv line", () => {
    const rows = parseDarwinPsRows(PS);
    assert.deepEqual(rows, [
      {
        pid: 91841,
        ppid: 91836,
        startTime: "Wed Nov 4 13:25:23 2026",
        args: "node /tmp/t3x-p91/listen.cjs 127.0.0.1 45611",
      },
      { pid: 1, ppid: 0, startTime: "Wed Sep 2 00:32:20 2026", args: "/sbin/launchd" },
      {
        pid: 91843,
        ppid: 91836,
        startTime: "Wed Nov 4 13:25:23 2026",
        args: "node /tmp/with space/listen.cjs * 45613",
      },
    ]);
  });

  it("reads `lsof -F pfnt` for IPv4, IPv6 and wildcard sockets, and ignores other ports", () => {
    assert.deepEqual(parseLsofListeners("p91841\nf12\ntIPv4\nn127.0.0.1:45611\n", 45611), [
      { pid: 91841, address: "127.0.0.1", family: "IPv4" },
    ]);
    assert.deepEqual(parseLsofListeners("p91842\nf12\ntIPv6\nn[::1]:45612\n", 45612), [
      { pid: 91842, address: "::1", family: "IPv6" },
    ]);
    assert.deepEqual(parseLsofListeners("p91843\nf12\ntIPv6\nn*:45613\n", 45613), [
      { pid: 91843, address: "*", family: "IPv6" },
    ]);
    assert.deepEqual(parseLsofListeners("p1\nf3\ntIPv4\nn127.0.0.1:80\n", 45611), []);
    assert.deepEqual(
      parseLsofListeners(
        "p7\nf3\ntIPv4\nn127.0.0.1:9\nf4\ntIPv6\nn[::1]:9\np8\nf3\ntIPv4\nn*:9\n",
        9,
      ).map((entry) => `${entry.pid}/${entry.address}`),
      ["7/127.0.0.1", "7/::1", "8/*"],
    );
    assert.deepEqual(parseLsofListeners("", 80), []);
  });
});

describe("Linux parsers (the kernel's documented formats)", () => {
  it("reads /proc/<pid>/stat whose command holds spaces and parentheses", () => {
    const stat =
      "4242 (my (weird) cmd) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 3 0 987654 1000 200 18446744073709551615";
    assert.deepEqual(parseProcStat(stat), { ppid: 1, startTime: "987654" });
    assert.isNull(parseProcStat("nothing here"));
    assert.isNull(parseProcStat("1 (x) S"));
  });

  it("reads LISTEN rows of /proc/net/tcp and tcp6, skipping other states", () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0",
      "   1: 00000000:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 100 0 0 10 0",
      "   2: 0100007F:1F92 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    assert.deepEqual(parseProcNetTcp(tcp, "IPv4"), [
      { address: "127.0.0.1", family: "IPv4", port: 8080, inode: "12345" },
      { address: "0.0.0.0", family: "IPv4", port: 8081, inode: "12346" },
    ]);
    const tcp6 = [
      "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22345 1 0000000000000000 100 0 0 10 0",
      "   1: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22346 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    const rows = parseProcNetTcp(tcp6, "IPv6");
    assert.deepEqual(
      rows.map((row) => normalizeListenAddress(row.address)),
      ["::1", "*"],
    );
    assert.deepEqual(
      rows.map((row) => row.port),
      [8080, 8081],
    );
  });
});

const layerLive = realInspectorLayer.pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe.runIf(runsOnRealProcesses)("reads of real processes", () => {
  it.live("table, start time, launch text and listeners of real children", () =>
    Effect.gen(function* () {
      const inspector = yield* ProcessInspector;
      const processes = yield* TestProcesses;
      const a = yield* processes.listen("127.0.0.1");
      const b = yield* processes.listen("::1");
      const c = yield* processes.listen("*");
      const table = yield* inspector.table;
      for (const child of [a, b, c]) {
        const row = table.get(child.pid);
        assert.equal(row?.ppid, process.pid);
        assert.equal(yield* inspector.startTime(child.pid), row?.startTime);
      }
      // One call answers for several ports, in the order asked.
      const [onA, onB, onC, onNone] = yield* inspector.listeners([a.port, b.port, c.port, 1]);
      const brief = (entries: ReadonlyArray<{ pid: number; address: string }>) =>
        entries.map((e) => [e.pid, e.address]);
      assert.deepEqual(brief(onA!), [[a.pid, "127.0.0.1"]]);
      assert.deepEqual(brief(onB!), [[b.pid, "::1"]]);
      assert.deepEqual(brief(onC!), [[c.pid, "*"]]);
      assert.deepEqual(onNone, []);
      assert.deepEqual(
        yield* inspector.listenersOf([
          { pid: a.pid, port: a.port },
          { pid: b.pid, port: b.port },
          { pid: b.pid, port: a.port },
        ]),
        [onA!, onB!, []],
      );
      assert.deepEqual(yield* inspector.listeners([]), []);
      assert.deepEqual(yield* inspector.listenersOf([]), []);
      const text = yield* inspector.launchText(a.pid);
      assert.include(text ?? "", "listen.cjs");
      assert.isFalse((text ?? "").includes("T3CODE_THREAD_ID"));
      const marked = yield* processes.listen("127.0.0.1", { marker: "thread-marker-1" });
      assert.include(
        (yield* inspector.launchText(marked.pid)) ?? "",
        "T3CODE_THREAD_ID=thread-marker-1",
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerLive, TestProcesses.layer))),
  );

  it.live("a process that has exited has no start time, launch text or listeners", () =>
    Effect.gen(function* () {
      const inspector = yield* ProcessInspector;
      const processes = yield* TestProcesses;
      const child = yield* processes.listen("127.0.0.1");
      yield* processes.stop(child);
      assert.isNull(yield* inspector.startTime(child.pid));
      assert.isNull(yield* inspector.launchText(child.pid));
      assert.deepEqual(yield* inspector.listeners([child.port]), [[]]);
      assert.isFalse((yield* inspector.table).has(child.pid));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerLive, TestProcesses.layer))),
  );

  it.live("two processes sharing a port with SO_REUSEPORT both show up", () =>
    Effect.gen(function* () {
      const inspector = yield* ProcessInspector;
      const processes = yield* TestProcesses;
      const first = yield* processes.listen("127.0.0.1", { reusePort: true });
      const second = yield* processes.listen("127.0.0.1", { reusePort: true, port: first.port });
      const pids = (yield* inspector.listeners([first.port]))[0]!
        .map((entry) => entry.pid)
        .toSorted();
      assert.deepEqual(pids, [first.pid, second.pid].toSorted());
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerLive, TestProcesses.layer))),
  );
});
