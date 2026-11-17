// fork: decides, for every new tunnel, whether the port may be dialed and at which address
// (research/remote-loopback-forwarding.md 5.3). The port-discovery snapshot, or failing that the
// one throttled listeners read, only nominates a process; each tunnel then re-proves, from fresh
// reads, that the process listening now is that same instance and that it is a terminal's or an
// agent's. Tunnels that arrive together share one set of reads (a batch); a read started before a
// tunnel arrived is never used for it, and nothing is kept from one batch to the next.
// @effect-diagnostics nodeBuiltinImport:off -- `realpath` of configured binaries.
import { LOOPBACK_GATEWAY_BLOCKED_PORTS } from "@t3tools/shared/forkLoopbackGateway/protocol";
import type { LoopbackGatewayServerErrorCode } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as NodeFS from "node:fs";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { classifyListener } from "./GatewayExclusions.ts";
import * as LoopbackGatewayGrants from "./LoopbackGatewayGrants.ts";
import * as ProcessInspector from "./ProcessInspector.ts";
import type { ListenerEntry } from "./ProcessInspector.ts";
import type { ExtraExecutable } from "./RuntimeSignatures.ts";
import * as TerminalShellRegistry from "./TerminalShellRegistry.ts";

/** Why a tunnel was refused. `reason` is a fixed phrase and never carries process data. */
export class GatewayRefusal extends Schema.TaggedError<GatewayRefusal>()("GatewayRefusal", {
  code: Schema.String,
  reason: Schema.String,
}) {}

export const refuse = (code: LoopbackGatewayServerErrorCode, reason: string) =>
  new GatewayRefusal({ code, reason });

export interface DialTarget {
  /** The one address to connect to: the listener's own loopback address, or `127.0.0.1` for a wildcard. */
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly pid: number;
}

export class PortAuthorizer extends Context.Service<
  PortAuthorizer,
  { readonly authorize: (port: number) => Effect.Effect<DialTarget, GatewayRefusal> }
>()("t3/fork/loopbackGateway/PortAuthorizer") {}

/** Provider binaries the user configured, which a root's argv may name instead of the default. */
export class ConfiguredExecutables extends Context.Service<
  ConfiguredExecutables,
  { readonly read: Effect.Effect<ReadonlyArray<ExtraExecutable>> }
>()("t3/fork/loopbackGateway/PortAuthorizer/ConfiguredExecutables") {}

export const layerConfiguredExecutables = Layer.effect(
  ConfiguredExecutables,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return ConfiguredExecutables.of({
      read: settings.getSettings.pipe(
        Effect.map((all) =>
          Object.values(all.providerInstances).flatMap((instance) => {
            const config = instance.config;
            const binaryPath =
              typeof config === "object" && config !== null && "binaryPath" in config
                ? config.binaryPath
                : undefined;
            return typeof binaryPath === "string" && binaryPath.trim().length > 0
              ? [{ driver: String(instance.driver), binaryPath: binaryPath.trim() }]
              : [];
          }),
        ),
        Effect.orElseSucceed((): ReadonlyArray<ExtraExecutable> => []),
      ),
    });
  }),
);

/** Tunnels arriving within this long of the first one, while no check runs, share one batch. */
export const COLLECT_WINDOW_MS = 10;

const realPathOf = (path: string): string | null => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return null;
  }
};

/** At most one rescan this often when a port is not in the snapshot or a check failed. */
export const RESCAN_MIN_INTERVAL_MS = 2_000;

/** Picks the address to dial from what one process listens on at the port; `null` if none is loopback. */
export const chooseDialHost = (
  entries: ReadonlyArray<ListenerEntry>,
): "127.0.0.1" | "::1" | null => {
  if (entries.some((entry) => entry.address === "127.0.0.1")) return "127.0.0.1";
  if (entries.some((entry) => entry.address === "::1")) return "::1";
  // A wildcard answers on loopback too; the design dials `127.0.0.1` for it.
  return entries.some((entry) => entry.address === "*") ? "127.0.0.1" : null;
};

export interface PortAuthorizerOptions {
  readonly serverPid: number;
  /** Ports of this server's own listeners, on top of the blocked-port table. */
  readonly reservedPorts: Effect.Effect<ReadonlySet<number>>;
}

export const make = Effect.fn("LoopbackGateway.makePortAuthorizer")(function* (
  options: PortAuthorizerOptions,
) {
  const discovery = yield* PortScanner.PortDiscovery;
  const inspector = yield* ProcessInspector.ProcessInspector;
  const shells = yield* TerminalShellRegistry.TerminalShellRegistry;
  const configured = yield* ConfiguredExecutables;
  const grants = yield* LoopbackGatewayGrants.LoopbackGatewayGrants;
  // The user's allowed ports, read for each authorization and each batch; no copy is kept here.
  const grantedPorts = grants.list.pipe(
    Effect.map((entries) => new Set(entries.map((entry) => entry.port))),
  );
  const lastRescan = yield* Ref.make<number | null>(null);

  // A miss or a failed check may mean the snapshot is stale: scan again, but not more than once
  // per interval however many tunnels ask.
  const rescanIfAllowed = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const allowed = yield* Ref.modify(lastRescan, (previous): readonly [boolean, number | null] =>
      previous === null || now - previous >= RESCAN_MIN_INTERVAL_MS
        ? [true, now]
        : [false, previous],
    );
    return allowed ? yield* discovery.scan() : null;
  });

  const nominate = (
    servers: ReadonlyArray<{ readonly port: number; readonly pid: number | null }>,
    port: number,
  ) => servers.find((server) => server.port === port && server.pid !== null)?.pid ?? null;

  const unverifiable = (error: ProcessInspector.ProcessInspectError) =>
    Effect.logWarning("loopback gateway: could not read the process table", {
      reason: error.reason,
    }).pipe(
      Effect.andThen(rescanIfAllowed.pipe(Effect.ignore, Effect.forkDetach)),
      Effect.andThen(Effect.fail(refuse("owner-changed", "the listener could not be verified"))),
    );

  /** The owner moved or went: the snapshot may be stale, so scan again (throttled). */
  const changed = rescanIfAllowed.pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid);

  interface Pending {
    readonly pid: number;
    readonly port: number;
    readonly done: Deferred.Deferred<
      DialTarget,
      GatewayRefusal | ProcessInspector.ProcessInspectError
    >;
    cancelled: boolean;
  }

  type Outcome =
    | { readonly refusal: GatewayRefusal }
    | { readonly host: "127.0.0.1" | "::1"; readonly first: string };

  /** One batch: the same C0 to C3 as a lone tunnel would do, with each read made once. */
  const runBatch = Effect.fn("LoopbackGateway.verifyBatch")(function* (
    batch: ReadonlyArray<Pending>,
  ) {
    const ports = [...new Set(batch.map((request) => request.port))];
    const pids = [...new Set(batch.map((request) => request.pid))];
    // C0 and C1 and the launch reads, together.
    const [table, listenerSets, launches] = yield* Effect.all(
      [
        inspector.table,
        inspector.listeners(ports),
        Effect.forEach(pids, (pid) => inspector.launchText(pid), { concurrency: 8 }),
      ],
      { concurrency: "unbounded" },
    );
    const listenersOn = new Map(ports.map((port, index) => [port, listenerSets[index]!]));
    const launchOf = new Map(pids.map((pid, index) => [pid, launches[index]!]));
    const shellsNow = yield* shells.shells;
    const extraExecutables = yield* configured.read;
    const grantedNow = yield* grantedPorts;

    // C2: prove ownership of each instance now.
    const outcomes = batch.map((request): Outcome => {
      const { pid, port } = request;
      const row = table.get(pid);
      const launchText = launchOf.get(pid) ?? null;
      const listeners = listenersOn.get(port) ?? [];
      if (row === undefined || launchText === null) {
        return { refusal: refuse("owner-changed", "the listener is gone") };
      }
      if (listeners.length === 0 || listeners.some((entry) => entry.pid !== pid)) {
        return {
          refusal: refuse("owner-changed", "the port has another or more than one listener"),
        };
      }
      const verdict = classifyListener({
        serverPid: options.serverPid,
        table,
        listenerPid: pid,
        launchText,
        shells: shellsNow,
        granted: grantedNow.has(port),
        extraExecutables,
        resolvePath: realPathOf,
      });
      if (!verdict.allow) return { refusal: refuse(verdict.code, verdict.reason) };
      const host = chooseDialHost(listeners);
      return host === null
        ? { refusal: refuse("not-loopback", "the service is not bound to loopback") }
        : { host, first: row.startTime };
    });

    // C3: still the same instance, still on the same socket. Starts after every C2 above.
    const surviving = batch.flatMap((request, index) => {
      const outcome = outcomes[index]!;
      return "refusal" in outcome ? [] : [{ request, outcome }];
    });
    const survivingPids = [...new Set(surviving.map(({ request }) => request.pid))];
    const [startTimes, held] = yield* Effect.all(
      [
        Effect.forEach(survivingPids, (pid) => inspector.startTime(pid), { concurrency: 8 }),
        inspector.listenersOf(
          surviving.map(({ request }) => ({ pid: request.pid, port: request.port })),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const secondOf = new Map(survivingPids.map((pid, index) => [pid, startTimes[index]!]));
    const verdicts = new Map<Pending, DialTarget | GatewayRefusal>();
    batch.forEach((request, index) => {
      const outcome = outcomes[index]!;
      if ("refusal" in outcome) verdicts.set(request, outcome.refusal);
    });
    surviving.forEach(({ request, outcome }, index) => {
      if ("refusal" in outcome) return;
      if (secondOf.get(request.pid) !== outcome.first) {
        verdicts.set(request, refuse("owner-changed", "the listener changed while it was checked"));
      } else if (chooseDialHost(held[index]!) !== outcome.host) {
        verdicts.set(request, refuse("owner-changed", "the listener's address changed"));
      } else {
        verdicts.set(request, { host: outcome.host, port: request.port, pid: request.pid });
      }
    });
    return verdicts;
  });

  // The queue and the drain loop live in the layer's scope, so a tunnel that is interrupted (its
  // session ended) leaves the batch it was waiting in without stopping it for the others.
  const scope = yield* Effect.scope;
  const queue: Array<Pending> = [];
  let draining = false;
  const drain = Effect.gen(function* () {
    // Nothing is being checked: let tunnels that arrive together join one batch.
    yield* Effect.sleep(Duration.millis(COLLECT_WINDOW_MS));
    while (true) {
      // Everything queued now arrived before the reads below begin; later arrivals wait for the next batch.
      const batch = queue.splice(0).filter((request) => !request.cancelled);
      if (batch.length > 0) {
        const exit = yield* Effect.exit(runBatch(batch));
        for (const request of batch) {
          if (exit._tag === "Failure") {
            yield* Deferred.failCause(request.done, exit.cause);
            continue;
          }
          const verdict = exit.value.get(request)!;
          yield* "_tag" in verdict
            ? Deferred.fail(request.done, verdict)
            : Deferred.succeed(request.done, verdict);
        }
      }
      if (queue.length === 0) {
        draining = false;
        return;
      }
    }
  });

  const check = Effect.fn("LoopbackGateway.verify")(function* (pid: number, port: number) {
    const done = yield* Deferred.make<
      DialTarget,
      GatewayRefusal | ProcessInspector.ProcessInspectError
    >();
    const request: Pending = { pid, port, done, cancelled: false };
    queue.push(request);
    if (!draining) {
      draining = true;
      yield* Effect.forkIn(drain, scope);
    }
    return yield* Deferred.await(done).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          request.cancelled = true;
        }),
      ),
    );
  });

  // Nominates for a port the snapshot lacks (a terminal's new service is not in it until the next
  // poll); `check` still decides. At most once per interval for the whole server: same-port requests
  // share the read, others and failed reads get `unknown`.
  type ListenerRead =
    | { readonly kind: "empty" }
    | { readonly kind: "sole"; readonly pid: number }
    | { readonly kind: "unknown" };
  const UNKNOWN: ListenerRead = { kind: "unknown" };
  type Reads = {
    readonly at: number;
    readonly byPort: ReadonlyMap<number, Deferred.Deferred<ListenerRead>>;
  };
  type ReadPlan = readonly ["read" | "share" | "skip", Deferred.Deferred<ListenerRead> | null];
  const reads = yield* Ref.make<Reads | null>(null);
  const describeListeners = (entries: ReadonlyArray<ListenerEntry> | undefined): ListenerRead => {
    if (entries === undefined) return UNKNOWN;
    const first = entries[0];
    if (first === undefined) return { kind: "empty" };
    return entries.every((entry) => entry.pid === first.pid)
      ? { kind: "sole", pid: first.pid }
      : UNKNOWN;
  };
  // Uninterruptible from claiming the read to installing its completion, so a request that was
  // given `read` always completes `mine` and the ones sharing it cannot hang. Only the listeners
  // read itself, and the wait on someone else's read, can be interrupted.
  const readListeners = Effect.fn("LoopbackGateway.readListeners")((port: number) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const mine = yield* Deferred.make<ListenerRead>();
        const [role, shared] = yield* Ref.modify(
          reads,
          (state): readonly [ReadPlan, Reads | null] => {
            if (state === null || now - state.at >= RESCAN_MIN_INTERVAL_MS) {
              return [["read", mine], { at: now, byPort: new Map([[port, mine]]) }];
            }
            const existing = state.byPort.get(port);
            return existing === undefined ? [["skip", null], state] : [["share", existing], state];
          },
        );
        if (role === "skip") return UNKNOWN;
        if (role === "share") return yield* restore(Deferred.await(shared!));
        return yield* restore(inspector.listeners([port])).pipe(
          Effect.map(([entries]) => describeListeners(entries)),
          Effect.orElseSucceed(() => UNKNOWN),
          Effect.onExit((exit) =>
            Deferred.succeed(mine, exit._tag === "Success" ? exit.value : UNKNOWN),
          ),
        );
      }),
    ),
  );

  // A port the user allowed is not in the snapshot, which only lists owned servers, and the shared
  // read above may be skipped for the interval. This one is not throttled: the user is waiting on
  // it, and only the ports they allowed come here.
  const readGrantedListeners = (port: number) =>
    inspector.listeners([port]).pipe(
      Effect.map(([entries]) => describeListeners(entries)),
      Effect.orElseSucceed(() => UNKNOWN),
    );

  const authorize = Effect.fn("LoopbackGateway.authorize")(function* (port: number) {
    if (LOOPBACK_GATEWAY_BLOCKED_PORTS.has(port) || (yield* options.reservedPorts).has(port)) {
      return yield* refuse("reserved", "this port is reserved");
    }
    const granted = (yield* grantedPorts).has(port);
    let pid = nominate(yield* discovery.scanBackground(), port);
    if (pid === null && !granted) {
      const rescanned = yield* rescanIfAllowed;
      pid = rescanned === null ? null : nominate(rescanned, port);
    }
    if (pid === null) {
      const read = granted ? yield* readGrantedListeners(port) : yield* readListeners(port);
      if (read.kind === "empty") {
        return yield* refuse("upstream-refused", "nothing is listening on this port");
      }
      if (read.kind === "unknown") {
        // A port the user allowed is never `not-owned`: the card would offer to allow it again.
        return yield* granted
          ? refuse("owner-changed", "the listener of an allowed port could not be identified")
          : refuse("not-owned", "no terminal or agent of this environment owns this port");
      }
      pid = read.pid;
    }
    return yield* check(pid, port).pipe(
      Effect.tapError((error) =>
        error._tag === "GatewayRefusal" && error.code === "owner-changed" ? changed : Effect.void,
      ),
      Effect.catchTags({ ProcessInspectError: unverifiable }),
    );
  });

  return PortAuthorizer.of({ authorize });
});

export const layer = Layer.effect(
  PortAuthorizer,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* make({
      serverPid: process.pid,
      reservedPorts: Effect.succeed(new Set([config.port])),
    });
  }),
);
