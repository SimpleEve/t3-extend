import { ProviderDriverKind, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import type {
  PiDialect,
  PiDialectLaunch,
  PiDialectLaunchInput,
} from "@t3tools/provider-pi/server/dialect";
import { PiProviderCapabilitiesV2 } from "@t3tools/provider-pi/server/adapter";
import type { PiLaunchArgsResolution } from "@t3tools/provider-pi/server/mcpInjection";

import { makeOmpRpcConnection } from "./connection.ts";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");

// omp enforces approvals itself (`--approval-mode`), and has no Pi-style subagent tool to surface:
// its `task` tool appears as an ordinary tool call.
const OmpProviderCapabilities = {
  ...PiProviderCapabilitiesV2,
  runtimePolicy: { enforcement: "native" },
  subagents: {
    ...PiProviderCapabilitiesV2.subagents,
    supportsSubagents: false,
    emitsSubagentLifecycle: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

/** T3's runtime modes as omp's own `--approval-mode` values. */
const APPROVAL_MODES = {
  "approval-required": "always-ask",
  auto: "always-ask",
  "auto-accept-edits": "write",
  "full-access": "yolo",
} as const;

// Flags T3 owns: the mode, session binding, one-shot runs, and anything that would loosen approvals.
const RESERVED_ARGUMENTS = new Set([
  "--mode",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--restore",
  "--no-session",
  "--print",
  "-p",
  "--export",
  "--help",
  "-h",
  "--version",
  "-v",
  "--approval-mode",
  "--auto-approve",
  "--yolo",
  "--plan-yolo",
  "--goal",
  "--alias",
  "--no-ui",
]);

// Flags that take a value, from `omp --help`; a token after any other flag is a stray prompt.
const ARGUMENTS_WITH_VALUES = new Set([
  "--model",
  "--smol",
  "--slow",
  "--plan",
  "--prewalk-into",
  "--plan-yolo-into",
  "--provider",
  "--api-key",
  "--system-prompt",
  "--system-prompt-template",
  "--append-system-prompt",
  "--profile",
  "--cwd",
  "--config",
  "--add-dir",
  "--session-dir",
  "--models",
  "--tools",
  "--thinking",
  "--service-tier",
  "--hook",
  "--extension",
  "-e",
  "--skills",
  "--spinner-interval",
  "--max-fps",
  "--motion",
  "--max-time",
  "--warn-cost",
  "--max-cost",
]);

export function resolveOmpLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
  const args = tokenizeCliArgs(launchArgs).flatMap((arg) => {
    const equals = arg.indexOf("=");
    const option = equals > 0 ? arg.slice(0, equals) : arg;
    return equals > 0 && ARGUMENTS_WITH_VALUES.has(option)
      ? [option, arg.slice(equals + 1)]
      : [arg];
  });
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    // `--flag=value` is one token for flags outside the value list, so match its name alone.
    const name = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (RESERVED_ARGUMENTS.has(name)) {
      return {
        ok: false,
        message: `omp launch argument '${name}' is controlled by T3 Code and cannot be overridden.`,
      };
    }
    if (arg === "--" || !arg.startsWith("-")) {
      return {
        ok: false,
        message: `omp launch arguments cannot include positional prompt '${arg}'.`,
      };
    }
    if (ARGUMENTS_WITH_VALUES.has(arg)) {
      if (args[index + 1] === undefined) {
        return { ok: false, message: `omp launch argument '${arg}' requires a value.` };
      }
      index += 1;
    }
  }
  return { ok: true, args };
}

export function buildOmpRpcLaunch(input: PiDialectLaunchInput): PiDialectLaunch {
  const args = [
    // omp 18.20.2 only activates host tools (T3's MCP tools) in plain rpc mode; rpc-ui lists them
    // but never sends them to the model. The cost is omp's `ask` tool, which only rpc-ui offers.
    "--mode",
    "rpc",
    ...(input.ephemeral === true
      ? ["--no-session"]
      : input.sessionPath !== undefined
        ? ["--resume", input.sessionPath]
        : []),
    ...input.launchArgs,
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
    ...(input.runtimeMode === undefined
      ? []
      : ["--approval-mode", APPROVAL_MODES[input.runtimeMode]]),
    ...(input.mcpSession === undefined
      ? []
      : ["--append-system-prompt", T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()]),
  ];
  return { args, env: { ...input.environment } };
}

export const OMP_DIALECT: PiDialect = {
  driverKind: OMP_PROVIDER,
  defaultBinary: "omp",
  capabilities: OmpProviderCapabilities,
  reportsTurnTokenUsage: true,
  // Approvals are omp's own and T3's tools arrive as host tools, so there is nothing to install.
  materializeExtension: () => Effect.undefined,
  resolveLaunchArgs: resolveOmpLaunchArgs,
  buildLaunch: buildOmpRpcLaunch,
  connect: makeOmpRpcConnection,
};
