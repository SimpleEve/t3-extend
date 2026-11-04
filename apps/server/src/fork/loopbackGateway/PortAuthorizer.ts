// fork: decides, for every new tunnel, whether the port may be dialed and at which address
// (research/remote-loopback-forwarding.md 5.3). The port-discovery snapshot only nominates a
// process; each tunnel then re-proves, from fresh reads, that the process listening now is that
// same instance and that it is a terminal's or an agent's. Nothing is cached between tunnels.
import { LOOPBACK_GATEWAY_BLOCKED_PORTS } from "@t3tools/shared/forkLoopbackGateway/protocol";
import type { LoopbackGatewayServerErrorCode } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { classifyListener } from "./GatewayExclusions.ts";
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

  const changed = (reason: string) =>
    rescanIfAllowed.pipe(
      Effect.ignore,
      Effect.forkDetach,
      Effect.andThen(Effect.fail(refuse("owner-changed", reason))),
    );

  const verify = Effect.fn("LoopbackGateway.verify")(function* (pid: number, port: number) {
    // C0: this process instance, from one snapshot of the whole table.
    const table = yield* inspector.table;
    const row = table.get(pid);
    if (row === undefined) return yield* changed("the listener is gone");
    const first = row.startTime;
    // C1 and the launch read are independent.
    const [listeners, launchText] = yield* Effect.all(
      [inspector.listeners(port), inspector.launchText(pid)],
      { concurrency: "unbounded" },
    );
    if (launchText === null) return yield* changed("the listener is gone");
    if (listeners.length === 0 || listeners.some((entry) => entry.pid !== pid)) {
      return yield* changed("the port has another or more than one listener");
    }
    // C2: prove ownership of this instance now.
    const verdict = classifyListener({
      serverPid: options.serverPid,
      table,
      listenerPid: pid,
      launchText,
      shells: yield* shells.shells,
      extraExecutables: yield* configured.read,
    });
    if (!verdict.allow) return yield* refuse(verdict.code, verdict.reason);
    const host = chooseDialHost(listeners);
    if (host === null) return yield* refuse("not-owned", "the service is not bound to loopback");
    // C3: still the same instance, still on the same socket.
    const [second, again] = yield* Effect.all(
      [inspector.startTime(pid), inspector.listenersOf(pid, port)],
      {
        concurrency: "unbounded",
      },
    );
    if (second !== first) return yield* changed("the listener changed while it was checked");
    if (chooseDialHost(again) !== host) return yield* changed("the listener's address changed");
    return { host, port, pid } satisfies DialTarget;
  });

  const authorize = Effect.fn("LoopbackGateway.authorize")(function* (port: number) {
    if (LOOPBACK_GATEWAY_BLOCKED_PORTS.has(port) || (yield* options.reservedPorts).has(port)) {
      return yield* refuse("reserved", "this port is reserved");
    }
    let pid = nominate(yield* discovery.scanBackground(), port);
    if (pid === null) {
      const rescanned = yield* rescanIfAllowed;
      pid = rescanned === null ? null : nominate(rescanned, port);
    }
    if (pid === null)
      return yield* refuse("not-owned", "no terminal or agent of this environment owns this port");
    return yield* verify(pid, port).pipe(Effect.catchTags({ ProcessInspectError: unverifiable }));
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
