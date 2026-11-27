// fork: `t3x devices`, the headless face of the device-key service. Like `t3 auth`, it opens the
// state directory in-process, so owning the files is the permission; no HTTP and no session.
// @effect-diagnostics nodeBuiltinImport:off -- The computer's host name is its default device name.
import * as NodeOS from "node:os";

import { DeviceKeysError } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceDirectory from "../fork/deviceKeys/DeviceDirectory.ts";
import * as DeviceKeysService from "../fork/deviceKeys/DeviceKeysService.ts";
import { layerServices } from "../fork/deviceKeys/layer.ts";
import { renderTerminalQrCode } from "../startupAccess.ts";
import { tunnelCommand } from "./devicesTunnel.ts"; // fork: 8.3
import { visibilityCommand } from "./devicesVisibility.ts";
import { authLocationFlags, resolveCliAuthConfig, type CliAuthLocationFlags } from "./config.ts";
import { reportDeviceErrors } from "./devicesReport.ts"; // fork: 8.3

export const runWithDevices = Effect.fn("devices.run")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: Effect.Effect<A, E, DeviceKeysService.DeviceKeysService | DeviceDirectory.DeviceDirectory>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  return yield* run.pipe(
    reportDeviceErrors,
    // The layer's level covers building it; the command's own logs (a failed sync) need it too.
    options?.quietLogs
      ? Effect.provideService(References.MinimumLogLevel, "Error")
      : (self) => self,
    Effect.provide(
      layerServices.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(EnvironmentAuth.layerRuntime),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(References.MinimumLogLevel, options?.quietLogs ? "Error" : config.logLevel),
        ),
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const when = (seconds: number | undefined) =>
  seconds === undefined ? "never" : DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const joinCommand = Command.make("join", {
  ...authLocationFlags,
  invite: Argument.String("invite").pipe(
    Argument.withDescription("The invite from your server (`t3x1.…`)."),
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("How this computer is listed. Defaults to its host name."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Join this computer to your server."),
  Command.withHandler((flags) =>
    runWithDevices(
      flags,
      Effect.gen(function* () {
        const service = yield* DeviceKeysService.DeviceKeysService;
        const status = yield* service.join({
          invite: flags.invite,
          name: Option.getOrElse(flags.name, () => NodeOS.hostname().split(".")[0] ?? "computer"),
        });
        yield* Console.log(`Joined as ${status.name} (${status.url ?? "no public address yet"}).`);
      }),
    ),
  ),
);

/**
 * A list older than this missed three 60-second syncs, the same threshold the settings page uses
 * for "can't reach the server right now".
 */
const LIST_STALE_SECONDS = 180;

// Read-only: it never asks the registry or touches state. A sync from this process would run beside
// the server's own, with its own gate, and could delete the device key (design 3.8).
const listCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List the devices on your server, as of the last sync."),
  Command.withHandler((flags) =>
    runWithDevices(
      flags,
      Effect.gen(function* () {
        const state = yield* (yield* DeviceDirectory.DeviceDirectory).state;
        const fetchedAt = Option.match(state.list, {
          onNone: () => null,
          onSome: (list) => list.fetchedAt,
        });
        const devices = Option.match(state.list, {
          onNone: () => [],
          onSome: (list) => list.devices,
        });
        const self = Option.match(state.membership, {
          onNone: () => undefined,
          onSome: (membership) => membership.deviceId,
        });
        if (flags.json) {
          yield* Console.log(toJson({ staleness: state.staleness, fetchedAt, self, devices }));
          return;
        }
        if (devices.length === 0 || fetchedAt === null) {
          yield* Console.log(
            "This computer has not joined a server. Run `t3x devices join <invite>`.",
          );
          return;
        }
        const age = state.nowSeconds - fetchedAt;
        yield* Console.log(
          age > LIST_STALE_SECONDS
            ? `Last synced with your server ${when(fetchedAt)}, ${Math.floor(age / 60)} minutes ago. T3 may not be running on this computer, or your server may be unreachable; \`t3x devices tunnel status\` shows whether T3 is running.`
            : `Last synced with your server ${when(fetchedAt)}.`,
        );
        for (const device of devices) {
          yield* Console.log(
            [
              device.name,
              device.id === self ? " (this computer)" : "",
              `  ${device.kind}`,
              device.url === undefined ? "" : `  ${device.url}`,
              `  last seen ${when(device.lastSeenAt)}`,
            ].join(""),
          );
        }
      }),
      { quietLogs: flags.json },
    ),
  ),
);

const inviteCommand = Command.make("invite", {
  ...authLocationFlags,
  kind: Flag.Literals("kind", ["phone", "computer"]).pipe(
    Flag.withDescription("What the invite is for."),
    Flag.withDefault("phone"),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Make a one-time invite for another device."),
  Command.withHandler((flags) =>
    runWithDevices(
      flags,
      Effect.gen(function* () {
        const created = yield* (yield* DeviceKeysService.DeviceKeysService).invite(flags.kind);
        if (flags.json) {
          yield* Console.log(toJson(created));
          return;
        }
        yield* Console.log(
          [
            `Invite for a ${flags.kind} (valid until ${when(created.expiresAt)}, usable once):`,
            "",
            renderTerminalQrCode(created.invite),
            "",
            created.invite,
            "",
          ].join("\n"),
        );
      }),
      { quietLogs: flags.json },
    ),
  ),
);

const removeCommand = Command.make("remove", {
  ...authLocationFlags,
  device: Argument.String("device").pipe(
    Argument.withDescription("The device's name, or the start of its id."),
  ),
}).pipe(
  Command.withDescription("Remove a device from your server."),
  Command.withHandler((flags) =>
    runWithDevices(
      flags,
      Effect.gen(function* () {
        const state = yield* (yield* DeviceDirectory.DeviceDirectory).state;
        const wanted = flags.device.toLowerCase();
        const matches = Option.match(state.list, {
          onNone: () => [],
          onSome: (list) => list.devices,
        }).filter(
          (device) =>
            device.name.toLowerCase() === wanted ||
            (wanted.length >= 8 && device.id.startsWith(flags.device)),
        );
        const [target] = matches;
        if (matches.length !== 1 || target === undefined) {
          return yield* new DeviceKeysError({
            reason: "invalid_input",
            message:
              matches.length === 0
                ? `No device named ${flags.device}. Run \`t3x devices list\`.`
                : `More than one device matches ${flags.device}; use the start of its id.`,
          });
        }
        const removed = yield* (yield* DeviceKeysService.DeviceKeysService).remove(target.id);
        yield* Console.log(`Removed ${target.name}.`);
        for (const pending of removed.pendingComputers) {
          yield* Console.log(
            `${pending.name} has not synced since; it learns of this the next time it reaches the server.`,
          );
        }
      }),
    ),
  ),
);

const leaveCommand = Command.make("leave", { ...authLocationFlags }).pipe(
  Command.withDescription("Take this computer off your server."),
  Command.withHandler((flags) =>
    runWithDevices(
      flags,
      Effect.gen(function* () {
        yield* (yield* DeviceKeysService.DeviceKeysService).leave;
        yield* Console.log("This computer left the server.");
      }),
    ),
  ),
);

export const devicesCommand = Command.make("devices").pipe(
  Command.withDescription("Join computers and phones to your own server."),
  Command.withSubcommands([
    joinCommand,
    listCommand,
    inviteCommand,
    removeCommand,
    leaveCommand,
    visibilityCommand(runWithDevices),
    tunnelCommand,
  ]),
);
