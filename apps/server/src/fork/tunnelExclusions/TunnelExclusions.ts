// fork: what upstream's preview tunnel (`/api/preview/tunnel`) never reaches, whoever asks: the
// blocked-port table, debug processes, and T3's own processes (this server and what started it,
// its children that are no terminal and no provider, provider runtimes). A page in a forwarded
// tab can open any tunnel its session can, so these stay out of its reach.
// @effect-diagnostics nodeBuiltinImport:off -- `realpath` of configured binaries.
import * as NodeFS from "node:fs";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../../serverSettings.ts";
import { classifyListener, serverChildOf } from "./ExclusionRules.ts";
import * as ProcessInspector from "./ProcessInspector.ts";
import type { ExtraExecutable } from "./RuntimeSignatures.ts";
import * as TerminalShellRegistry from "./TerminalShellRegistry.ts";

/** Ports debuggers and daemons use, refused before anything is read. */
const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  9222, // Chrome DevTools protocol
  9229, // Node inspector
  5858, // legacy Node debugger
  5859,
  2375, // Docker daemon
  2376,
  5005, // JDWP
  5678, // debugpy
]);

/** A page loads over several connections at once; they share one read of the process table. */
export const VERDICT_TTL_MS = 2_000;

export type TunnelRefusalCode = "reserved" | "debug-process" | "unverified";

export interface TunnelRefusal {
  readonly code: TunnelRefusalCode;
}

export interface TunnelExclusionsShape {
  /** Why `port` must not be tunnelled, or `null`. Never fails: an unreadable host refuses. */
  readonly check: (port: number) => Effect.Effect<TunnelRefusal | null>;
}

/** Allows everything until the server provides the real check, so upstream's tests run as before. */
export const TunnelExclusions = Context.Reference<TunnelExclusionsShape>(
  "t3/fork/tunnelExclusions/TunnelExclusions",
  { defaultValue: () => ({ check: () => Effect.succeed(null) }) },
);

/** Provider binaries the user configured, which a root's argv may name instead of the default. */
export class ConfiguredExecutables extends Context.Service<
  ConfiguredExecutables,
  { readonly read: Effect.Effect<ReadonlyArray<ExtraExecutable>> }
>()("t3/fork/tunnelExclusions/TunnelExclusions/ConfiguredExecutables") {}

const layerConfiguredExecutables = Layer.effect(
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

const realPathOf = (path: string): string | null => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return null;
  }
};

export const make = Effect.fn("TunnelExclusions.make")(function* (options: {
  readonly serverPid: number;
}) {
  const inspector = yield* ProcessInspector.ProcessInspector;
  const shells = yield* TerminalShellRegistry.TerminalShellRegistry;
  const configured = yield* ConfiguredExecutables;
  const platform = yield* HostProcess.Platform;
  // Windows has no process reads; there only the blocked ports apply.
  const inspects = platform === "darwin" || platform === "linux";

  const inspect = Effect.fn("TunnelExclusions.inspect")(function* (port: number) {
    const [entries = []] = yield* inspector.listeners([port]);
    const pids = [...new Set(entries.map((entry) => entry.pid))];
    if (pids.length === 0) return null;
    const [table, launches] = yield* Effect.all(
      [inspector.table, Effect.forEach(pids, inspector.launchText, { concurrency: 4 })],
      { concurrency: "unbounded" },
    );
    const roots = pids.map((pid) => serverChildOf(table, options.serverPid, pid));
    const rootReads = [...new Set(roots.filter((root, i) => root !== null && root !== pids[i]))];
    const rootTexts = new Map(
      yield* Effect.forEach(
        rootReads as ReadonlyArray<number>,
        (root) => Effect.map(inspector.launchText(root), (text) => [root, text] as const),
        { concurrency: 4 },
      ),
    );
    const shellsNow = yield* shells.shells;
    const extraExecutables = yield* configured.read;
    for (const [index, listenerPid] of pids.entries()) {
      const verdict = classifyListener({
        serverPid: options.serverPid,
        table,
        listenerPid,
        launchText: launches[index] ?? "",
        rootLaunchText: rootTexts.get(roots[index] ?? -1) ?? null,
        shells: shellsNow,
        extraExecutables,
        resolvePath: realPathOf,
      });
      if (!verdict.allow) return { code: verdict.code } satisfies TunnelRefusal;
    }
    return null;
  });

  const verdicts = new Map<
    number,
    { readonly at: number; readonly result: Deferred.Deferred<TunnelRefusal | null> }
  >();
  const unverified: TunnelRefusal = { code: "unverified" };

  const check = Effect.fn("TunnelExclusions.check")(function* (port: number) {
    if (BLOCKED_PORTS.has(port)) return { code: "reserved" } satisfies TunnelRefusal;
    if (!inspects) return null;
    const now = yield* Clock.currentTimeMillis;
    const cached = verdicts.get(port);
    if (cached !== undefined && now - cached.at < VERDICT_TTL_MS) {
      return yield* Deferred.await(cached.result);
    }
    const result = yield* Deferred.make<TunnelRefusal | null>();
    verdicts.set(port, { at: now, result });
    const refusal = yield* inspect(port).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("preview tunnel: could not read the process table", {
          reason: error.reason,
        }),
      ),
      Effect.orElseSucceed(() => unverified),
      Effect.onInterrupt(() => Deferred.succeed(result, unverified)),
    );
    yield* Deferred.succeed(result, refusal);
    return refusal;
  });

  return { check } satisfies TunnelExclusionsShape;
});

export const layer = Layer.effect(TunnelExclusions, make({ serverPid: process.pid })).pipe(
  Layer.provide(layerConfiguredExecutables),
  Layer.provide(TerminalShellRegistry.layer),
  Layer.provide(ProcessInspector.layer),
);
