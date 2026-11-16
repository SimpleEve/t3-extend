import { type ServerProviderModel } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseCliVersionResult,
  providerModelsFromSettings,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  parsePiDiscoveredCommands,
  withPiBuiltinSlashCommands,
} from "@t3tools/provider-pi/server/commands";
import {
  piRecordField as recordField,
  piRecordString as recordString,
} from "@t3tools/provider-pi/server/rpc";

import type { OmpSettings } from "../settings.ts";
import { OMP_DIALECT, OMP_PROVIDER, resolveOmpLaunchArgs } from "./dialect.ts";
import { EMPTY_OMP_MODEL_CAPABILITIES, ompModelCapabilities } from "./modelCapabilities.ts";

const OMP_PRESENTATION = {
  displayName: "omp",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
// The RPC surface T3 relies on (prompt_result, host tools, get_available_commands) is verified from here.
const MINIMUM_OMP_VERSION = "18.20.0";

const OMP_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "omp default",
  isCustom: false,
  capabilities: EMPTY_OMP_MODEL_CAPABILITIES,
};

const modelsFromSettings = (
  customModels: OmpSettings["customModels"] | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
) =>
  providerModelsFromSettings(
    [OMP_DEFAULT_MODEL, ...discovered],
    customModels ?? [],
    EMPTY_OMP_MODEL_CAPABILITIES,
  );

export function parseOmpModels(
  data: unknown,
  state: unknown,
): ReadonlyArray<ServerProviderModel> | undefined {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) return undefined;
  const active = recordField(state, "model");
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    // Image-generation catalog entries have no chat input and cannot start a turn.
    if (provider === undefined || id === undefined || recordField(model, "kind") === "image") {
      continue;
    }
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const isActive =
      provider === recordString(active, "provider") && id === recordString(active, "id");
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      subProvider: provider,
      isCustom: false,
      capabilities: ompModelCapabilities(
        model,
        isActive ? recordString(state, "thinkingLevel") : undefined,
      ),
    });
  }
  return parsed;
}

const discoverViaRpc = Effect.fn("OmpProviderStatus.discoverViaRpc")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd: string | undefined,
) {
  const launch = OMP_DIALECT.buildLaunch({
    launchArgs,
    environment,
    mcpSession: undefined,
    extensionPath: undefined,
    ephemeral: true,
    shortLived: true,
  });
  const connection = yield* OMP_DIALECT.connect({
    command: settings.binaryPath || OMP_DIALECT.defaultBinary,
    args: launch.args,
    cwd,
    env: launch.env,
  });
  yield* Stream.fromQueue(connection.events).pipe(
    Stream.runDrain,
    Effect.ignore,
    Effect.forkScoped,
  );
  const timeoutMs = resolveProviderProbeTimeoutMs("omp", DISCOVERY_TIMEOUT_MS, environment);
  const state = yield* connection.request({ type: "get_state" }, timeoutMs);
  const modelsData = yield* connection.request({ type: "get_available_models" }, timeoutMs);
  const commandsData = yield* connection
    .request({ type: "get_commands" }, timeoutMs)
    .pipe(Effect.orElseSucceed(() => undefined));
  const models = parseOmpModels(modelsData, state);
  if (models === undefined) return undefined;
  const { slashCommands, skills } = parsePiDiscoveredCommands(commandsData);
  return {
    models,
    slashCommands: withPiBuiltinSlashCommands(slashCommands),
    skills,
  };
}, Effect.scoped);

/** The commands and skills available in one workspace, which can differ from the machine's. */
export const discoverOmpCommandsForCwd = Effect.fn("discoverOmpCommandsForCwd")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const launchArgs = resolveOmpLaunchArgs(settings.launchArgs);
  const discovery = launchArgs.ok
    ? yield* discoverViaRpc(settings, providerProbeEnvironment(environment), launchArgs.args, cwd)
    : undefined;
  return {
    slashCommands: discovery?.slashCommands ?? withPiBuiltinSlashCommands([]),
    skills: discovery?.skills ?? [],
  };
});

const runVersionCommand = Effect.fn("OmpProviderStatus.runVersionCommand")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || OMP_DIALECT.defaultBinary;
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

export const buildInitialOmpProviderSnapshot = Effect.fn(
  "OmpProviderStatus.buildInitialOmpProviderSnapshot",
)(function* (settings: OmpSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  return buildServerProvider({
    driver: OMP_PROVIDER,
    presentation: OMP_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: modelsFromSettings(settings.customModels),
    probe: settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking omp CLI availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "omp is disabled in T3 Code settings.",
        },
  });
});

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSettings(settings.customModels);
  const draft = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models = fallbackModels,
  ) =>
    buildServerProvider({
      driver: OMP_PROVIDER,
      presentation: OMP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!settings.enabled) {
    return draft({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "omp is disabled in T3 Code settings.",
    });
  }

  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* runVersionCommand(settings, probeEnvironment).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("omp", VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("omp CLI health check failed.", { errorTag: error._tag });
    return draft({
      installed: !isCommandMissingCause(error),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(error)
        ? "omp CLI (`omp`) is not installed or not on PATH. See https://github.com/can1357/oh-my-pi."
        : "Failed to execute omp CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return draft({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "omp CLI is installed but timed out while running `omp --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseCliVersionResult(versionOutput);
  if (versionOutput.code !== 0) {
    return draft({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "omp CLI is installed but failed to run.",
    });
  }
  if (version === null) {
    return draft({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `T3 Code could not determine the omp version. omp ${MINIMUM_OMP_VERSION} or newer is required.`,
    });
  }
  if (compareSemverVersions(version, MINIMUM_OMP_VERSION) < 0) {
    return draft({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `omp ${version} is unsupported. Update to omp ${MINIMUM_OMP_VERSION} or newer.`,
    });
  }
  const launchArgs = resolveOmpLaunchArgs(settings.launchArgs);
  if (!launchArgs.ok) {
    return draft({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: launchArgs.message,
    });
  }

  const discoveryExit = yield* discoverViaRpc(
    settings,
    probeEnvironment,
    launchArgs.args,
    cwd,
  ).pipe(
    Effect.timeoutOption(resolveProviderProbeTimeoutMs("omp", DISCOVERY_TIMEOUT_MS, environment)),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit) || Option.isNone(discoveryExit.value)) {
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning("omp RPC discovery failed.", {
        errorTag: causeErrorTag(discoveryExit.cause),
      });
    }
    return draft({
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message:
        "omp is available, but T3 Code could not refresh its models and commands. The live session will retry startup.",
    });
  }
  const discovery = discoveryExit.value.value;
  if (discovery === undefined) {
    return draft({
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message: "omp returned an unreadable model catalog. The live session will retry startup.",
    });
  }
  const authenticated = discovery.models.length > 0;
  return {
    ...buildServerProvider({
      driver: OMP_PROVIDER,
      presentation: OMP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromSettings(settings.customModels, discovery.models),
      slashCommands: discovery.slashCommands,
      skills: discovery.skills,
      probe: {
        installed: true,
        version,
        status: authenticated ? "ready" : "warning",
        auth: { status: authenticated ? "authenticated" : "unauthenticated", type: "omp" },
        ...(authenticated
          ? {}
          : {
              message:
                "omp has no usable models. Run `omp` in a terminal and use /login, or configure a provider in ~/.omp/agent.",
            }),
      },
    }),
    supportsTextGeneration: false,
  };
});
