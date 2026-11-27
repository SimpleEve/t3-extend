// fork: `t3x devices visibility`, the headless way to choose which devices may see this computer.
// It saves the setting in the state directory like the settings page does (both call
// `DeviceKeysService.setVisibility`); a running server reads the saved file on the next pass.
import {
  DeviceKeysError,
  type DeviceVisibility,
  type DevicesStatus,
  type RegistryHiddenPeer,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import * as DeviceDirectory from "../fork/deviceKeys/DeviceDirectory.ts";
import * as DeviceKeysService from "../fork/deviceKeys/DeviceKeysService.ts";
import { authLocationFlags, type CliAuthLocationFlags } from "./config.ts";
import type { runWithDevices } from "./devices.ts";

type Listed = { readonly id: string; readonly name?: string };

/**
 * Turns names (or the start of an id, at least 8 characters) into device ids from the saved list.
 * Computers hidden from this one are in the list by id only, so only an id can pick them.
 */
export const resolveDevices = (
  refs: ReadonlyArray<string>,
  input: {
    readonly devices: ReadonlyArray<Listed>;
    readonly hiddenPeers: ReadonlyArray<Pick<RegistryHiddenPeer, "id">>;
    readonly selfId: string | undefined;
  },
): ReadonlyArray<string> | string => {
  const candidates: ReadonlyArray<Listed> = [...input.devices, ...input.hiddenPeers];
  const ids: Array<string> = [];
  for (const ref of refs) {
    const wanted = ref.toLowerCase();
    const matches = candidates.filter(
      (device) =>
        device.name?.toLowerCase() === wanted || (wanted.length >= 8 && device.id.startsWith(ref)),
    );
    const [only] = matches;
    if (matches.length === 0 || only === undefined) {
      // Not a sync from here: a second process syncing beside the running server has its own gate and could
      // delete this computer's key (docs/internals/self-hosted-devices.md), so a newcomer waits for that server's sync.
      return `No device named ${ref} in the list from the last sync (\`t3x devices list\`). A device that joined after it is not here yet: use the start of its id (at least 8 characters, \`./t3x devices\` on your server shows it), or try again about a minute after the running T3 has synced.`;
    }
    if (matches.length > 1) {
      return `More than one device matches ${ref}; use the start of its id.`;
    }
    if (only.id === input.selfId) return "This computer cannot be in its own list.";
    ids.push(only.id);
  }
  return ids;
};

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const describeUnreadable =
  "The saved setting could not be read, so this computer refuses every device until you save a new one (`t3x devices visibility all|none|hide|only`).";

const describeMode = (visibility: NonNullable<DevicesStatus["visibility"]>, names: string) => {
  switch (visibility.mode) {
    case "visible_to_all":
      return "Visible to all devices.";
    case "hidden_from_all":
      return "Hidden from all devices.";
    case "hidden_from_selected":
      return `Hidden from: ${names}.`;
    case "visible_to_selected":
      return `Visible only to: ${names}.`;
  }
};

const describeRegistry = (registry: NonNullable<DevicesStatus["visibility"]>["registry"]) => {
  switch (registry) {
    case "synced":
      return "Your server has this setting.";
    case "pending":
      return "Your server has not received this setting yet; this computer already applies it, and retries every minute while T3 runs.";
    case "unsupported":
      return "Your server is too old to hide this computer from lists. Update it; this computer already refuses the devices above.";
    case "unknown":
      return "Whether your server has this setting is not known yet.";
  }
};

const withService = <A, E>(
  flags: CliAuthLocationFlags & { readonly json: boolean },
  run: (
    service: DeviceKeysService.DeviceKeysService["Service"],
    directory: DeviceDirectory.DeviceDirectory["Service"],
  ) => Effect.Effect<A, E>,
  runWithDevices: RunWithDevices,
) =>
  runWithDevices(
    flags,
    Effect.gen(function* () {
      return yield* run(
        yield* DeviceKeysService.DeviceKeysService,
        yield* DeviceDirectory.DeviceDirectory,
      );
    }),
    { quietLogs: flags.json },
  );

type RunWithDevices = typeof runWithDevices;

export const visibilityCommand = (runWithDevices: RunWithDevices) => {
  const names = (
    state: Effect.Success<DeviceDirectory.DeviceDirectory["Service"]["state"]>,
    ids: ReadonlyArray<string>,
  ) =>
    ids
      .map(
        (id) =>
          Option.getOrUndefined(state.list)?.devices.find((device) => device.id === id)?.name ??
          `${id.slice(0, 8)}…`,
      )
      .join(", ");

  const report = Effect.fn("devices.visibility.report")(function* (
    directory: DeviceDirectory.DeviceDirectory["Service"],
    json: boolean,
  ) {
    const status = yield* directory.status;
    const state = yield* directory.state;
    const visibility = status.visibility;
    if (visibility === undefined) {
      return yield* new DeviceKeysError({
        reason: "not_joined",
        message: "This computer has not joined a server. Run `t3x devices join <invite>`.",
      });
    }
    if (json) {
      yield* Console.log(toJson(visibility));
      return;
    }
    if (visibility.unreadable === true) {
      yield* Console.log(describeUnreadable);
      return;
    }
    yield* Console.log(describeMode(visibility, names(state, visibility.deviceIds)));
    yield* Console.log(describeRegistry(visibility.registry));
  });

  const apply = (
    flags: CliAuthLocationFlags & { readonly json: boolean },
    choose: (
      resolve: (
        refs: ReadonlyArray<string>,
      ) => Effect.Effect<ReadonlyArray<string>, DeviceKeysError>,
    ) => Effect.Effect<DeviceVisibility, DeviceKeysError>,
  ) =>
    withService(
      flags,
      (service, directory) =>
        Effect.gen(function* () {
          const state = yield* directory.state;
          const resolve = Effect.fn("devices.visibility.resolve")(function* (
            refs: ReadonlyArray<string>,
          ) {
            const list = Option.getOrUndefined(state.list);
            const resolved = resolveDevices(refs, {
              devices: list?.devices ?? [],
              hiddenPeers: list?.hiddenPeers ?? [],
              selfId: Option.getOrUndefined(state.membership)?.deviceId,
            });
            if (typeof resolved === "string") {
              return yield* new DeviceKeysError({ reason: "invalid_input", message: resolved });
            }
            return resolved;
          });
          const visibility = yield* choose(resolve);
          yield* service.setVisibility(visibility);
          yield* report(directory, flags.json);
        }),
      runWithDevices,
    );

  const jsonFlag = Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of human-readable output."),
    Flag.withDefault(false),
  );
  const flagsFor = { ...authLocationFlags, json: jsonFlag };
  const devicesArg = Argument.String("device").pipe(
    Argument.withDescription("A device's name, or the start of its id."),
    Argument.atLeast(1),
  );

  const show = Command.make("show", flagsFor).pipe(
    Command.withDescription("Show who may see this computer."),
    Command.withHandler((flags) =>
      withService(flags, (_service, directory) => report(directory, flags.json), runWithDevices),
    ),
  );
  const all = Command.make("all", flagsFor).pipe(
    Command.withDescription("Let every device on your server see this computer (the default)."),
    Command.withHandler((flags) =>
      apply(flags, () => Effect.succeed({ mode: "visible_to_all", deviceIds: [] })),
    ),
  );
  const none = Command.make("none", flagsFor).pipe(
    Command.withDescription(
      "Hide this computer from every device, including ones that join later.",
    ),
    Command.withHandler((flags) =>
      apply(flags, () => Effect.succeed({ mode: "hidden_from_all", deviceIds: [] })),
    ),
  );
  const hide = Command.make("hide", { ...flagsFor, devices: devicesArg }).pipe(
    Command.withDescription(
      "Hide this computer from the named devices; devices that join later can see it.",
    ),
    Command.withHandler((flags) =>
      apply(flags, (resolve) =>
        Effect.map(resolve(flags.devices), (deviceIds) => ({
          mode: "hidden_from_selected" as const,
          deviceIds,
        })),
      ),
    ),
  );
  const only = Command.make("only", { ...flagsFor, devices: devicesArg }).pipe(
    Command.withDescription(
      "Show this computer only to the named devices; devices that join later cannot see it.",
    ),
    Command.withHandler((flags) =>
      apply(flags, (resolve) =>
        Effect.map(resolve(flags.devices), (deviceIds) => ({
          mode: "visible_to_selected" as const,
          deviceIds,
        })),
      ),
    ),
  );

  return Command.make("visibility").pipe(
    Command.withDescription("Choose which devices on your server can see this computer."),
    Command.withSubcommands([show, all, none, hide, only]),
  );
};
