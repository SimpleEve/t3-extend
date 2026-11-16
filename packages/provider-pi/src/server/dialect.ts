// fork: lets the omp driver (packages/provider-omp) reuse the Pi adapter without copying it.
import type { OrchestrationV2ProviderCapabilities, ProviderDriverKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type { materializePiT3McpExtension, PiLaunchArgsResolution } from "./mcpInjection.ts";
import type { makePiRpcConnection, PiRpcSpawnOptions } from "./rpc.ts";

export interface PiDialectConnectOptions extends PiRpcSpawnOptions {
  /** Lets a dialect expose T3's MCP tools natively instead of through an injected extension. */
  readonly mcpSession?: McpProviderSessionConfig | undefined;
}

export interface PiDialectLaunchInput {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly sessionPath?: string | undefined;
  readonly ephemeral?: boolean;
  readonly shortLived?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
}

export interface PiDialectLaunch {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * What differs between Pi and a Pi-family agent that speaks a close dialect of Pi's RPC
 * protocol. Everything else in the adapter stays shared.
 */
export interface PiDialect {
  readonly driverKind: ProviderDriverKind;
  /** Binary name used when the settings carry no explicit path. */
  readonly defaultBinary: string;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  /** Pi injects a permission and MCP extension; dialects with native equivalents return undefined. */
  readonly materializeExtension: (
    cacheDir: string,
  ) => Effect.Effect<
    string | undefined,
    Effect.Error<ReturnType<typeof materializePiT3McpExtension>>,
    FileSystem.FileSystem
  >;
  readonly resolveLaunchArgs: (launchArgs: string) => PiLaunchArgsResolution;
  readonly buildLaunch: (input: PiDialectLaunchInput) => PiDialectLaunch;
  /** Spawns the agent and returns a connection speaking Pi's RPC shapes. */
  readonly connect: (options: PiDialectConnectOptions) => ReturnType<typeof makePiRpcConnection>;
}
