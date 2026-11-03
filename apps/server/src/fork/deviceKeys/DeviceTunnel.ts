// fork: the server runs frpc for this computer (design Q7 / 3.7). While the computer belongs to a
// server it writes frpc's config and a fresh ticket, starts frpc, reads its three rejection
// sentences, and restarts it with back-off. frpc only ever runs as a child that this module
// spawned and holds the handle of; a `Scope` closing kills it (its whole process group, see frpcProcess).
import type { DeviceTunnelStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import { forkParked } from "../../serverActivation.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import { writeFileAtomic } from "./atomicWrite.ts";
import { writeDevicePublicUrl } from "./devicePublicUrlSync.ts";
import * as FrpBinary from "./frpBinary.ts";
import { frpcCommand } from "./frpcProcess.ts";
import {
  issueTicket,
  parseTicketLifetimeOverride,
  renderFrpcConfig,
  TICKET_ROTATION_SECONDS,
} from "./frpcConfig.ts";
import {
  actionFor,
  classifyFrpcLine,
  describeFrpcLine,
  frpcLines,
  type FrpcLogEvent,
} from "./frpcLog.ts";
import * as TunnelListener from "./TunnelListener.ts";
import {
  encodeTunnelStatusFile,
  TUNNEL_DIR,
  TUNNEL_HEARTBEAT_SECONDS,
  TUNNEL_STATUS_FILE,
} from "@t3tools/shared/forkDeviceKeys/tunnelStatusFile";

const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 32, 60] as const;
const STABLE_AFTER = Duration.seconds(30);

/** Seconds to wait after the `failures`-th failure in a row: 1, 2, 4 … capped at a minute. */
export const backoffSeconds = (failures: number): number =>
  BACKOFF_SECONDS[Math.min(failures, BACKOFF_SECONDS.length - 1)] ?? 60;

/** A run that lasted 30 seconds counts as healthy: the next failure starts the sequence over. */
export const failuresAfterRun = (failures: number, ranForMillis: number): number =>
  ranForMillis >= Duration.toMillis(STABLE_AFTER) ? 0 : failures;
const KILL_GRACE = Duration.seconds(3);
const CA_FILE_ENV = "T3X_TUNNEL_CA_FILE";
/** Test-only: make tickets live this many seconds, so an expiry can be watched. Unset in production. */
const TICKET_LIFETIME_ENV = "T3X_TEST_TICKET_LIFETIME_SECONDS";
/** frpc needs none of the server's environment; these let it find its way around the OS. */
const FRPC_ENV_NAMES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

interface Desired {
  readonly key: string;
  readonly registryOrigin: string;
  readonly registryId: string;
  readonly deviceId: string;
  readonly subdomain: string;
  /** The device row's `created_at`, which the ticket's `gen` must equal. */
  readonly generation: number;
}

type RunOutcome =
  /** The ticket reached half its life: start again at once with a new one. */
  | "rotate"
  /** frpc said its ticket is not good: start again, after back-off, with a new one. */
  | "renew"
  | "exited"
  | "unavailable";

const MESSAGES = {
  revoked: "The server says this computer was removed; checking.",
  renew: "The tunnel login was refused; renewing it.",
  busy: "The server was busy; retrying.",
  pluginError: "The server's tunnel check did not answer; retrying.",
} as const;

const make = Effect.fn("DeviceTunnel.make")(function* (options: {
  readonly trustedCaFile?: string | undefined;
  readonly ticketLifetimeSeconds?: number | undefined;
  /** Tests only: runs after every heartbeat write, so a test can wait on it instead of on time. */
  readonly onHeartbeat?: Effect.Effect<void> | undefined;
}) {
  const directory = yield* DeviceDirectory.DeviceDirectory;
  const identity = yield* DeviceIdentity.DeviceIdentity;
  const binary = yield* FrpBinary.FrpBinary;
  const listener = yield* TunnelListener.TunnelListener;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const hostEnv = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const serviceScope = yield* Effect.scope;
  const trustedCaFile =
    options.trustedCaFile ??
    Option.getOrUndefined(
      yield* Config.String(CA_FILE_ENV).pipe(
        Config.option,
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
    );

  const lifetimeText = yield* Config.String(TICKET_LIFETIME_ENV).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const ticketLifetimeSeconds =
    options.ticketLifetimeSeconds ??
    parseTicketLifetimeOverride(Option.getOrUndefined(lifetimeText));
  if (Option.isSome(lifetimeText) && ticketLifetimeSeconds === undefined) {
    yield* Effect.logWarning(
      `${TICKET_LIFETIME_ENV} must be a whole number of seconds from 1 to 86400; using 24 hours.`,
    );
  }

  const tunnelDir = path.join(config.stateDir, TUNNEL_DIR);
  const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000));

  const current = yield* Ref.make<DeviceTunnelStatus>({ status: "disabled", lastError: null });
  const frpcPid = yield* Ref.make<number | null>(null);
  // One writer at a time, so two status files never race to be the last rename.
  const statusFileLock = yield* Semaphore.make(1);
  const persistStatus = Effect.fn("DeviceTunnel.persistStatus")(function* (
    status: DeviceTunnelStatus,
  ) {
    yield* statusFileLock.withPermits(1)(
      Effect.gen(function* () {
        yield* fs.makeDirectory(tunnelDir, { recursive: true, mode: 0o700 });
        yield* writeFileAtomic(
          path.join(tunnelDir, TUNNEL_STATUS_FILE),
          encodeTunnelStatusFile({
            serverPid: process.pid,
            frpcPid: yield* Ref.get(frpcPid),
            status: status.status,
            lastError: status.lastError,
            updatedAt: yield* Clock.currentTimeMillis,
          }),
          0o600,
        );
      }),
    );
  });
  const setStatus = Effect.fn("DeviceTunnel.setStatus")(function* (next: DeviceTunnelStatus) {
    const previous = yield* Ref.getAndSet(current, next);
    if (previous.status === next.status && previous.lastError === next.lastError) return;
    yield* persistStatus(next).pipe(Effect.ignore);
    // Last, so that whoever sees the new status can rely on nothing async coming before the next step.
    yield* directory.setTunnelStatus(next);
  });
  // Refreshed while the server runs, changed or not: `tunnel status` believes only a recent file.
  const heartbeat = Ref.get(current).pipe(
    Effect.flatMap(persistStatus),
    Effect.ignore,
    Effect.andThen(options.onHeartbeat ?? Effect.void),
    Effect.repeat(Schedule.spaced(Duration.seconds(TUNNEL_HEARTBEAT_SECONDS))),
  );
  const setLastError = (lastError: string) =>
    Ref.get(current).pipe(Effect.flatMap((status) => setStatus({ ...status, lastError })));

  const refreshing = yield* Ref.make(false);
  const refreshOnce = Ref.getAndSet(refreshing, true).pipe(
    Effect.flatMap((already) =>
      already
        ? Effect.void
        : directory.sync.pipe(
            Effect.catch((error) =>
              Effect.logWarning("Device list refresh after a rejection failed.", {
                error: error.message,
              }),
            ),
            Effect.ensuring(Ref.set(refreshing, false)),
          ),
    ),
    // Not in the runner's fiber: a refresh that finds this computer removed interrupts the runner.
    Effect.forkIn(serviceScope),
    Effect.asVoid,
  );

  const reactTo = Effect.fn("DeviceTunnel.react")(function* (
    event: FrpcLogEvent,
    restart: Deferred.Deferred<void>,
  ) {
    if (event._tag === "Connected") {
      return yield* setStatus({ status: "connected", lastError: null });
    }
    yield* Effect.logWarning("frpc reported a rejection.", {
      source: event.source,
      reason: event.reason,
      text: event.reason === "other" ? event.text : undefined,
    });
    const status = yield* Ref.get(current);
    // A refused work connection does not mean the tunnel is down.
    const connection = event.source === "workConn" ? status.status : "connecting";
    const action = actionFor(event);
    if (action === "refresh") {
      yield* setStatus({ status: connection, lastError: MESSAGES.revoked });
      return yield* refreshOnce;
    }
    if (action === "renew") {
      yield* setStatus({ status: connection, lastError: MESSAGES.renew });
      return yield* Deferred.succeed(restart, undefined);
    }
    return yield* setStatus({
      status: connection,
      lastError:
        event.reason === "busy"
          ? MESSAGES.busy
          : event.reason === "plugin-error"
            ? MESSAGES.pluginError
            : `frpc: ${event.text}`,
    });
  });

  const runOnce = Effect.fn("DeviceTunnel.runOnce")(function* (desired: Desired) {
    const located = yield* Effect.result(binary.locate);
    if (located._tag === "Failure") {
      yield* setStatus({ status: "error", lastError: located.failure.message });
      return "unavailable" as const;
    }
    const key = yield* identity.peek.pipe(Effect.catch(() => Effect.succeedNone));
    if (Option.isNone(key)) {
      yield* setStatus({ status: "error", lastError: "This computer's device key is missing." });
      return "unavailable" as const;
    }
    const localPort = yield* listener.port;
    const issuedAt = yield* nowSeconds;
    const rendered = yield* Effect.try({
      try: () =>
        renderFrpcConfig({
          registryOrigin: desired.registryOrigin,
          deviceId: desired.deviceId,
          subdomain: desired.subdomain,
          ticket: issueTicket({
            key: key.value,
            registryId: desired.registryId,
            subdomain: desired.subdomain,
            generation: desired.generation,
            nowSeconds: issuedAt,
            lifetimeSeconds: ticketLifetimeSeconds,
          }),
          localPort,
          trustedCaFile,
        }),
      catch: (cause) => ({ _tag: "BadTunnelSettings" as const, cause }),
    }).pipe(Effect.result);
    if (rendered._tag === "Failure") {
      yield* Effect.logWarning("The tunnel config could not be built.", {
        cause: rendered.failure,
      });
      yield* setStatus({ status: "error", lastError: "The tunnel settings are not usable." });
      return "unavailable" as const;
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        // The ticket is a login credential: a directory only we can enter, a file only we can read,
        // and it is gone when this run ends.
        const configFile = path.join(tunnelDir, "frpc.toml");
        yield* fs.makeDirectory(tunnelDir, { recursive: true, mode: 0o700 });
        yield* fs.chmod(tunnelDir, 0o700);
        yield* fs.remove(configFile, { force: true });
        yield* fs.writeFileString(configFile, rendered.success, { mode: 0o600 });
        yield* fs.chmod(configFile, 0o600);
        yield* Effect.addFinalizer(() =>
          fs.remove(configFile, { force: true }).pipe(Effect.ignore),
        );

        const env: Record<string, string> = {};
        for (const name of FRPC_ENV_NAMES) {
          const value = hostEnv[name];
          if (value !== undefined) env[name] = value;
        }
        const child = yield* spawner.spawn(
          frpcCommand({
            platform,
            executable: located.success.path,
            configFile,
            env,
            killGrace: KILL_GRACE,
          }),
        );
        yield* Ref.set(frpcPid, Number(child.pid));
        yield* Effect.addFinalizer(() => Ref.set(frpcPid, null));
        yield* Effect.logInfo("frpc started.", {
          pid: Number(child.pid),
          source: located.success.source,
          subdomain: desired.subdomain,
        });
        yield* setStatus({ status: "connecting", lastError: null });

        const restart = yield* Deferred.make<void>();
        yield* child.all.pipe(
          frpcLines,
          Stream.runForEach((line) => {
            const event = classifyFrpcLine(line);
            return event === undefined
              ? Effect.suspend(() => Effect.logDebug("frpc:", { line: describeFrpcLine(line) }))
              : reactTo(event, restart);
          }),
          Effect.catch((cause) => Effect.logWarning("frpc's output could not be read.", { cause })),
          Effect.forkScoped,
        );

        return yield* Effect.raceAll([
          child.exitCode.pipe(
            Effect.map((code) => `frpc exited (code ${code}).`),
            Effect.orElseSucceed(() => "frpc was stopped."),
            Effect.flatMap((message) =>
              setLastError(message).pipe(Effect.as("exited" as const satisfies RunOutcome)),
            ),
          ),
          Deferred.await(restart).pipe(Effect.as("renew" as const satisfies RunOutcome)),
          Effect.sleep(Duration.seconds(TICKET_ROTATION_SECONDS)).pipe(
            Effect.as("rotate" as const satisfies RunOutcome),
          ),
        ]);
      }),
    );
  });

  /** Keeps frpc running for `desired` until the fiber is interrupted. */
  const runTunnel = Effect.fn("DeviceTunnel.runTunnel")(function* (desired: Desired) {
    let failures = 0;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      const outcome: RunOutcome = yield* runOnce(desired);
      failures = failuresAfterRun(failures, (yield* Clock.currentTimeMillis) - startedAt);
      if (outcome === "rotate") {
        failures = 0;
        continue;
      }
      const delay = backoffSeconds(failures);
      failures += 1;
      const { lastError } = yield* Ref.get(current);
      yield* setStatus({ status: outcome === "unavailable" ? "error" : "stopped", lastError });
      yield* Effect.sleep(Duration.seconds(delay));
    }
  });

  // Written before the tunnel reacts to the same change, so a status that shows the new membership
  // is never ahead of the file. `None` means nothing written yet, so a first removal still deletes.
  const writtenUrl = yield* Ref.make<Option.Option<Option.Option<string>>>(Option.none());
  const syncPublicUrl = Effect.gen(function* () {
    const wanted = yield* directory.tunnelOrigin;
    const previous = yield* Ref.get(writtenUrl);
    if (Option.isSome(previous) && Equal.equals(previous.value, wanted)) {
      return;
    }
    yield* writeDevicePublicUrl(config.stateDir, wanted).pipe(
      Effect.tap(() => Ref.set(writtenUrl, Option.some(wanted))),
      Effect.catch((cause) =>
        Effect.logWarning("Could not update the device public URL file.", { cause }),
      ),
    );
  });

  const desiredNow = directory.state.pipe(
    Effect.map(({ membership, list }): Option.Option<Desired> => {
      if (Option.isNone(membership) || Option.isNone(list)) return Option.none();
      const self = list.value.devices.find((device) => device.id === membership.value.deviceId);
      if (self === undefined) return Option.none();
      const m = membership.value;
      return Option.some({
        key: [m.registryOrigin, m.registryId, m.deviceId, m.subdomain, self.createdAt].join("|"),
        registryOrigin: m.registryOrigin,
        registryId: m.registryId,
        deviceId: m.deviceId,
        subdomain: m.subdomain,
        generation: self.createdAt,
      });
    }),
  );

  const follow = Effect.fn("DeviceTunnel.follow")(function* () {
    yield* directory.changes.pipe(
      Stream.mapEffect(() => syncPublicUrl.pipe(Effect.andThen(desiredNow))),
      Stream.changesWith(
        (a, b) =>
          Option.getOrNull(Option.map(a, (d) => d.key)) ===
          Option.getOrNull(Option.map(b, (d) => d.key)),
      ),
      Stream.switchMap((desired) =>
        Stream.fromEffect(
          Option.match(desired, {
            onNone: () =>
              setStatus({ status: "disabled", lastError: null }).pipe(Effect.andThen(Effect.never)),
            onSome: runTunnel,
          }),
        ),
      ),
      Stream.runDrain,
    );
  });

  return Effect.all([follow(), heartbeat], { concurrency: "unbounded", discard: true });
});

export const layer = (
  options: {
    readonly trustedCaFile?: string | undefined;
    readonly ticketLifetimeSeconds?: number | undefined;
    readonly onHeartbeat?: Effect.Effect<void> | undefined;
  } = {},
) =>
  Layer.effectDiscard(make(options).pipe(Effect.flatMap(forkParked))).pipe(
    Layer.provide(FrpBinary.layer()),
  );

/** server.ts: gives the tunnel the listener's port, and starts frpc once the server is active. */
export const withDeviceTunnel = <A, E, R>(served: Layer.Layer<A, E, R>) =>
  layer().pipe(Layer.provideMerge(served as Layer.Layer<A | TunnelListener.TunnelListener, E, R>));
