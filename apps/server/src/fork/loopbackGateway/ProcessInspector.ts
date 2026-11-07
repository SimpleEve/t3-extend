// fork: reads what the gateway's per-tunnel check needs from the host's process table
// (research/remote-loopback-forwarding.md 5.3). Every read is fresh; nothing here caches. The
// service is the injection point for identity, listener and ancestry reads, so tests can change
// what the check sees between its steps. macOS uses `ps` and `lsof`, Linux uses `/proc`.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../../processRunner.ts";

export class ProcessInspectError extends Schema.TaggedError<ProcessInspectError>()(
  "ProcessInspectError",
  { reason: Schema.String },
) {}

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** Opaque and only compared for equality: `lstart` text on macOS, clock ticks on Linux. */
  readonly startTime: string;
  readonly args: string;
}
export type ProcessTable = ReadonlyMap<number, ProcessRow>;

export interface ListenerEntry {
  readonly pid: number;
  /** `127.0.0.1`, `::1`, or `*` for either wildcard; anything else is some other address. */
  readonly address: string;
  readonly family: "IPv4" | "IPv6";
}

export interface ProcessInspectorShape {
  /** Every process, as one snapshot. */
  readonly table: Effect.Effect<ProcessTable, ProcessInspectError>;
  /** The start time of one process, `null` once it is gone. */
  readonly startTime: (pid: number) => Effect.Effect<string | null, ProcessInspectError>;
  /**
   * Every process with a TCP listener on each of `ports`, one answer per port in the same order.
   * One observation however many ports: a batch asks once.
   */
  readonly listeners: (
    ports: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<ListenerEntry>>, ProcessInspectError>;
  /** The listeners each `pid` alone holds on its `port`, one answer per pair in the same order. */
  readonly listenersOf: (
    pairs: ReadonlyArray<{ readonly pid: number; readonly port: number }>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<ListenerEntry>>, ProcessInspectError>;
  /** The argv and launch environment of `pid` as one text, `null` once it is gone. */
  readonly launchText: (pid: number) => Effect.Effect<string | null, ProcessInspectError>;
}

export class ProcessInspector extends Context.Service<ProcessInspector, ProcessInspectorShape>()(
  "t3/fork/loopbackGateway/ProcessInspector",
) {}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/u;

/** `ps -ww -o pid=,ppid=,lstart=,args=` (or `command=`), under `LC_ALL=C TZ=UTC`. */
export const parseDarwinPsRows = (stdout: string): ReadonlyArray<ProcessRow> => {
  const rows: Array<ProcessRow> = [];
  for (const line of stdout.split("\n")) {
    const match = PS_ROW.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startTime: match[3]!.replace(/\s+/gu, " "),
      args: match[4] ?? "",
    });
  }
  return rows;
};

/** `lsof -nP -F pfnt`: `p<pid>`, then per socket `f<fd>`, `t<type>`, `n<address>:<port>`. */
export const parseLsofListeners = (stdout: string, port: number): ReadonlyArray<ListenerEntry> => {
  const entries: Array<ListenerEntry> = [];
  let pid: number | null = null;
  let family: "IPv4" | "IPv6" | null = null;
  for (const line of stdout.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      family = null;
    } else if (tag === "f") {
      family = null;
    } else if (tag === "t") {
      family = value === "IPv4" || value === "IPv6" ? value : null;
    } else if (tag === "n" && pid !== null && family !== null) {
      const split = value.lastIndexOf(":");
      if (split < 0 || Number(value.slice(split + 1)) !== port) continue;
      const host = value.slice(0, split).replace(/^\[|\]$/gu, "");
      entries.push({
        pid,
        address: host === "127.0.0.1" || host === "::1" ? host : host === "*" ? "*" : host,
        family,
      });
    }
  }
  return entries;
};

/** `pid (comm) S ppid ...`: `comm` may hold spaces and parentheses, so split after the last `)`. */
export const parseProcStat = (
  raw: string,
): { readonly ppid: number; readonly startTime: string } | null => {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  return Number.isInteger(ppid) && startTime !== undefined && /^\d+$/u.test(startTime)
    ? { ppid, startTime }
    : null;
};

const hexWordsToIpv6 = (hex: string): string => {
  const groups: Array<string> = [];
  for (let word = 0; word < 4; word++) {
    const bytes = hex.slice(word * 8, word * 8 + 8).match(/../gu) ?? [];
    const be = [...bytes].toReversed().join("");
    groups.push(be.slice(0, 4), be.slice(4, 8));
  }
  return groups.map((group) => group.replace(/^0+(?=.)/u, "")).join(":");
};

export interface ProcNetSocket {
  readonly address: string;
  readonly family: "IPv4" | "IPv6";
  readonly port: number;
  readonly inode: string;
}

/** The LISTEN rows (state `0A`) of `/proc/net/tcp` or `/proc/net/tcp6`. */
export const parseProcNetTcp = (
  raw: string,
  family: "IPv4" | "IPv6",
): ReadonlyArray<ProcNetSocket> => {
  const sockets: Array<ProcNetSocket> = [];
  for (const line of raw.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 10 || fields[3] !== "0A") continue;
    const [hex, portHex] = (fields[1] ?? "").split(":");
    if (hex === undefined || portHex === undefined) continue;
    const port = Number.parseInt(portHex, 16);
    let address: string;
    if (family === "IPv4") {
      if (!/^[\dA-F]{8}$/u.test(hex)) continue;
      address = (hex.match(/../gu) ?? [])
        .toReversed()
        .map((byte) => Number.parseInt(byte, 16))
        .join(".");
    } else {
      if (!/^[\dA-F]{32}$/u.test(hex)) continue;
      address = hexWordsToIpv6(hex);
    }
    sockets.push({ address, family, port, inode: fields[9]! });
  }
  return sockets;
};

/** A `/proc` bind address as a `ListenerEntry` address. */
export const normalizeListenAddress = (address: string): string => {
  if (address === "0.0.0.0" || address === "0:0:0:0:0:0:0:0") return "*";
  if (address === "0:0:0:0:0:0:0:1") return "::1";
  return address;
};

const socketInodeOf = (target: string): string | null =>
  /^socket:\[(\d+)\]$/u.exec(target)?.[1] ?? null;

const TOOL_TIMEOUT = Duration.seconds(5);
const PS_ENV = { LC_ALL: "C", TZ: "UTC" } as const;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PROC_FD_LIMIT = 4096;

const makeDarwin = Effect.fn("ProcessInspector.makeDarwin")(function* (
  toolTimeout: Duration.Duration,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const run = Effect.fn("ProcessInspector.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    okCodes: ReadonlyArray<number>,
  ) {
    const result = yield* runner
      .run({
        command,
        args,
        env: { ...process.env, ...PS_ENV },
        timeout: toolTimeout,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError(
          (error) => new ProcessInspectError({ reason: `${command} failed: ${error._tag}` }),
        ),
      );
    if (result.timedOut || result.code === null || !okCodes.includes(Number(result.code))) {
      return yield* new ProcessInspectError({
        reason: `${command} exited with ${String(result.code)}`,
      });
    }
    return result.stdout;
  });
  const rowsOf = (stdout: string) =>
    new Map(parseDarwinPsRows(stdout).map((row) => [row.pid, row]));
  const psOne = (pid: number, column: "args" | "command", withEnvironment: boolean) =>
    run(
      "/bin/ps",
      [
        ...(withEnvironment ? ["-E"] : []),
        "-ww",
        "-o",
        `pid=,ppid=,lstart=,${column}=`,
        "-p",
        String(pid),
      ],
      [0, 1],
    ).pipe(Effect.map((stdout) => rowsOf(stdout).get(pid) ?? null));
  /** One `lsof` call: all TCP listeners, or only those of `pids`. */
  const lsof = (pids: ReadonlyArray<number> | null) =>
    run(
      "/usr/sbin/lsof",
      [
        "-nP",
        ...(pids === null ? [] : ["-a", "-p", pids.join(",")]),
        "-iTCP",
        "-sTCP:LISTEN",
        "-F",
        "pfnt",
      ],
      [0, 1],
    );
  return ProcessInspector.of({
    table: run("/bin/ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,args="], [0]).pipe(
      Effect.map(rowsOf),
    ),
    // `ps -p` exits 1 when no such process exists.
    startTime: Effect.fn("ProcessInspector.startTime")(function* (pid: number) {
      return (yield* psOne(pid, "args", false))?.startTime ?? null;
    }),
    listeners: Effect.fn("ProcessInspector.listeners")(function* (ports: ReadonlyArray<number>) {
      if (ports.length === 0) return [];
      const stdout = yield* lsof(null);
      return ports.map((port) => parseLsofListeners(stdout, port));
    }),
    listenersOf: Effect.fn("ProcessInspector.listenersOf")(function* (
      pairs: ReadonlyArray<{ readonly pid: number; readonly port: number }>,
    ) {
      if (pairs.length === 0) return [];
      const stdout = yield* lsof([...new Set(pairs.map((pair) => pair.pid))]);
      return pairs.map(({ pid, port }) =>
        parseLsofListeners(stdout, port).filter((entry) => entry.pid === pid),
      );
    }),
    // `ps -E` appends the launch environment to the argv.
    launchText: Effect.fn("ProcessInspector.launchText")(function* (pid: number) {
      return (yield* psOne(pid, "command", true))?.args ?? null;
    }),
  });
});

const makeLinux = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = (path: string) =>
    fs.readFileString(path).pipe(
      Effect.map((value): string | null => value),
      Effect.orElseSucceed((): string | null => null),
    );
  const procNames = fs
    .readDirectory("/proc")
    .pipe(Effect.mapError(() => new ProcessInspectError({ reason: "/proc is unreadable" })));
  const readStat = Effect.fn("ProcessInspector.readStat")(function* (pid: number) {
    const raw = yield* text(`/proc/${pid}/stat`);
    return raw === null ? null : parseProcStat(raw);
  });
  const cmdline = (pid: number) =>
    text(`/proc/${pid}/cmdline`).pipe(
      Effect.map((raw) => (raw ?? "").replace(/\0$/u, "").replaceAll("\0", " ")),
    );
  const socketsOnPort = Effect.fn("ProcessInspector.socketsOnPort")(function* (port: number) {
    const v4 = yield* text("/proc/net/tcp");
    const v6 = yield* text("/proc/net/tcp6");
    if (v4 === null && v6 === null) {
      return yield* new ProcessInspectError({ reason: "/proc/net/tcp is unreadable" });
    }
    return [...parseProcNetTcp(v4 ?? "", "IPv4"), ...parseProcNetTcp(v6 ?? "", "IPv6")].filter(
      (socket) => socket.port === port,
    );
  });
  const inodesOf = Effect.fn("ProcessInspector.inodesOf")(function* (pid: number) {
    const names = yield* fs
      .readDirectory(`/proc/${pid}/fd`)
      .pipe(Effect.orElseSucceed((): Array<string> | null => null));
    if (names === null) return null;
    if (names.length > PROC_FD_LIMIT) {
      return yield* new ProcessInspectError({ reason: "too many open files to read" });
    }
    const inodes = new Set<string>();
    for (const name of names) {
      const target = yield* fs
        .readLink(`/proc/${pid}/fd/${name}`)
        .pipe(Effect.orElseSucceed(() => ""));
      const inode = socketInodeOf(target);
      if (inode !== null) inodes.add(inode);
    }
    return inodes;
  });
  const entry = (pid: number, socket: ProcNetSocket): ListenerEntry => ({
    pid,
    address: normalizeListenAddress(socket.address),
    family: socket.family,
  });
  const listenersOnPort = Effect.fn("ProcessInspector.listenersOnPort")(function* (port: number) {
    const sockets = yield* socketsOnPort(port);
    if (sockets.length === 0) return [];
    const unowned = new Set(sockets.map((socket) => socket.inode));
    const entries: Array<ListenerEntry> = [];
    for (const name of yield* procNames) {
      if (!/^\d+$/u.test(name) || unowned.size === 0) continue;
      const inodes = yield* inodesOf(Number(name)).pipe(Effect.orElseSucceed(() => null));
      if (inodes === null) continue;
      for (const socket of sockets) {
        if (!inodes.has(socket.inode)) continue;
        unowned.delete(socket.inode);
        entries.push(entry(Number(name), socket));
      }
    }
    // A listening socket whose owner could not be read must not pass as "nobody else".
    if (unowned.size > 0) {
      return yield* new ProcessInspectError({
        reason: "a listener on the port has an unreadable owner",
      });
    }
    return entries;
  });
  const listenersHeldBy = Effect.fn("ProcessInspector.listenersHeldBy")(function* (
    pid: number,
    port: number,
  ) {
    const sockets = yield* socketsOnPort(port);
    const inodes = yield* inodesOf(pid);
    if (inodes === null) return [];
    return sockets.filter((socket) => inodes.has(socket.inode)).map((socket) => entry(pid, socket));
  });
  return ProcessInspector.of({
    table: Effect.gen(function* () {
      const rows = new Map<number, ProcessRow>();
      for (const name of yield* procNames) {
        if (!/^\d+$/u.test(name)) continue;
        const pid = Number(name);
        const stat = yield* readStat(pid);
        if (stat === null) continue;
        rows.set(pid, {
          pid,
          ppid: stat.ppid,
          startTime: stat.startTime,
          args: yield* cmdline(pid),
        });
      }
      return rows;
    }),
    startTime: Effect.fn("ProcessInspector.startTime")(function* (pid: number) {
      return (yield* readStat(pid))?.startTime ?? null;
    }),
    // The sockets on the port come from `/proc/net/tcp`; their owners from each process's fds.
    // The sockets on a port come from `/proc/net/tcp`; their owners from each process's fds.
    listeners: Effect.fn("ProcessInspector.listeners")(function* (ports: ReadonlyArray<number>) {
      return yield* Effect.forEach(ports, listenersOnPort);
    }),
    listenersOf: Effect.fn("ProcessInspector.listenersOf")(function* (
      pairs: ReadonlyArray<{ readonly pid: number; readonly port: number }>,
    ) {
      return yield* Effect.forEach(pairs, ({ pid, port }) => listenersHeldBy(pid, port));
    }),
    launchText: Effect.fn("ProcessInspector.launchText")(function* (pid: number) {
      const args = yield* cmdline(pid);
      const environ = yield* text(`/proc/${pid}/environ`);
      if (environ === null) {
        if ((yield* readStat(pid)) === null) return null;
        return yield* new ProcessInspectError({ reason: "the process environment is unreadable" });
      }
      return `${args} ${environ.replaceAll("\0", " ")}`;
    }),
  });
});

const unsupported = (platform: string) => {
  const refuse = () => new ProcessInspectError({ reason: `unsupported platform: ${platform}` });
  return ProcessInspector.of({
    table: Effect.fail(refuse()),
    startTime: Effect.fn("ProcessInspector.startTime")(function* (_pid: number) {
      return yield* refuse();
    }),
    listeners: Effect.fn("ProcessInspector.listeners")(function* (_ports: ReadonlyArray<number>) {
      return yield* refuse();
    }),
    listenersOf: Effect.fn("ProcessInspector.listenersOf")(function* (
      _pairs: ReadonlyArray<{ readonly pid: number; readonly port: number }>,
    ) {
      return yield* refuse();
    }),
    launchText: Effect.fn("ProcessInspector.launchText")(function* (_pid: number) {
      return yield* refuse();
    }),
  });
};

/** The macOS inspector with its own limit on each `ps` and `lsof` call, so a test on a loaded machine is not decided by the product's 5 s. */
export const layerDarwinWithTimeout = (toolTimeout: Duration.Duration) =>
  Layer.effect(ProcessInspector, makeDarwin(toolTimeout));

/** The platform's inspector; Windows has none, and the gateway is not advertised there. */
export const layer = Layer.effect(
  ProcessInspector,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (platform === "darwin") return yield* makeDarwin(TOOL_TIMEOUT);
    if (platform === "linux") return yield* makeLinux;
    return unsupported(platform);
  }),
);
