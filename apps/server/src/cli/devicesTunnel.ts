// fork: `t3x devices tunnel`, the headless side of the tunnel: fetch the pinned frpc, and say whether
// it and the tunnel are in order. Like the rest of `t3x devices` it opens the state directory
// in-process.
import { FRP_VERSION } from "@t3tools/shared/forkFrp";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceDirectory from "../fork/deviceKeys/DeviceDirectory.ts";
import * as FrpBinary from "../fork/deviceKeys/frpBinary.ts";
import { layerServices } from "../fork/deviceKeys/layer.ts";
import {
  decodeTunnelStatusFile,
  isServerRunning,
  TUNNEL_DIR,
  TUNNEL_STATUS_FILE,
} from "../fork/deviceKeys/tunnelStatusFile.ts";
import { authLocationFlags, resolveCliAuthConfig, type CliAuthLocationFlags } from "./config.ts";
import { reportDeviceErrors } from "./devicesReport.ts";

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** What `tunnel status` reports; also the `--json` shape. */
const tunnelReport = Effect.gen(function* () {
  const binary = yield* FrpBinary.FrpBinary;
  const directory = yield* DeviceDirectory.DeviceDirectory;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  const located = yield* Effect.result(binary.locate);
  const { membership } = yield* directory.state;
  const raw = yield* fs
    .readFileString(path.join(config.stateDir, TUNNEL_DIR, TUNNEL_STATUS_FILE))
    .pipe(Effect.option);
  const file = Option.flatMap(raw, decodeTunnelStatusFile);
  const nowMillis = yield* Clock.currentTimeMillis;
  return {
    frpc:
      located._tag === "Success"
        ? {
            ok: true as const,
            path: located.success.path,
            source: located.success.source,
            version: FRP_VERSION,
          }
        : {
            ok: false as const,
            problem: located.failure.problem,
            message: located.failure.message,
          },
    joined: Option.isSome(membership),
    url: Option.getOrNull(Option.map(membership, (m) => m.url)),
    deviceName: Option.getOrNull(Option.map(membership, (m) => m.name)),
    server: Option.match(file, {
      onNone: () => ({ running: false as const, lastUpdatedAt: null }),
      onSome: (value) =>
        isServerRunning(value, nowMillis, isRunning)
          ? {
              running: true as const,
              tunnel: value.status,
              lastError: value.lastError,
              updatedAt: value.updatedAt,
            }
          : { running: false as const, lastUpdatedAt: value.updatedAt },
    }),
  };
});

const withTunnelServices = Effect.fn("devices.tunnel.run")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: Effect.Effect<A, E, R>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  return yield* run.pipe(
    reportDeviceErrors,
    // `locate` warns about a candidate it skips; --json output must stay one JSON document.
    options?.quietLogs
      ? Effect.provideService(References.MinimumLogLevel, "Error")
      : (self) => self,
    Effect.provide(
      Layer.mergeAll(FrpBinary.layer(), layerServices).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(EnvironmentAuth.layerRuntime),
        Layer.provideMerge(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(References.MinimumLogLevel, options?.quietLogs ? "Error" : config.logLevel),
        ),
      ),
    ),
  );
});

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const installCommand = Command.make("install", { ...authLocationFlags }).pipe(
  Command.withDescription(
    `Download frpc ${FRP_VERSION} into the T3 home, checked against its pinned SHA-256.`,
  ),
  Command.withHandler((flags) =>
    withTunnelServices(
      flags,
      Effect.gen(function* () {
        const installed = yield* (yield* FrpBinary.FrpBinary).install;
        yield* Console.log(
          `Installed frpc ${FRP_VERSION} at ${installed.path}\n  from ${installed.url}\n  sha256 ${installed.sha256}`,
        );
      }),
    ),
  ),
);

const statusCommand = Command.make("status", {
  ...authLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of human-readable output."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Say whether frpc is installed and whether the tunnel is running."),
  Command.withHandler((flags) =>
    withTunnelServices(
      flags,
      Effect.gen(function* () {
        const report = yield* tunnelReport;
        if (flags.json) {
          yield* Console.log(toJson(report));
          return;
        }
        yield* Console.log(
          report.frpc.ok
            ? `frpc ${report.frpc.version}: ${report.frpc.path} (${report.frpc.source})`
            : `frpc: ${report.frpc.message}`,
        );
        yield* Console.log(
          report.joined
            ? `This computer is ${report.deviceName} at ${report.url}.`
            : "This computer has not joined a server. Run `t3x devices join <invite>`.",
        );
        const server = report.server;
        if (!report.joined) return;
        yield* Console.log(
          server.running
            ? `Tunnel: ${server.tunnel}${server.lastError === null ? "" : ` (${server.lastError})`}, as of ${DateTime.formatIso(DateTime.makeUnsafe(server.updatedAt))}.`
            : `The tunnel runs inside the T3 server; the server is not running${server.lastUpdatedAt === null ? "" : ` (it last reported at ${DateTime.formatIso(DateTime.makeUnsafe(server.lastUpdatedAt))})`}.`,
        );
      }),
      { quietLogs: flags.json },
    ),
  ),
);

export const tunnelCommand = Command.make("tunnel").pipe(
  Command.withDescription("Install and check the tunnel client (frpc)."),
  Command.withSubcommands([installCommand, statusCommand]),
);
