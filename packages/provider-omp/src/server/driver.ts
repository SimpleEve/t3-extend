// omp keeps user-wide state in ~/.omp/agent, so continuation identity uses default instance grouping.
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { enrichPiSnapshot } from "@t3tools/provider-pi/server/status";
import type { PiAdapterV2DriverEnv } from "@t3tools/provider-pi/server/adapter";

import { OmpSettings } from "../settings.ts";
import { OmpAdapterV2Driver } from "./adapter.ts";
import { OMP_PROVIDER } from "./dialect.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  discoverOmpCommandsForCwd,
} from "./status.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

// omp installs through its own script and `omp update`, neither of which T3 can vouch for, so
// updates stay manual.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: () =>
    Effect.succeed(
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: OMP_PROVIDER,
        packageName: null,
        manualCommand: "omp update",
      }),
    ),
};

const makeUnsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "omp instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
};

export type OmpDriverEnv =
  | PiAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv, Path.Path> = {
  driverKind: OMP_PROVIDER,
  metadata: {
    displayName: "omp",
    supportsMultipleInstances: true,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: Effect.fn("OmpDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const host = yield* ProviderHost.ProviderHost;
    const { cwd } = host.paths;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: OMP_PROVIDER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: OMP_PROVIDER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );

    const orchestrationAdapter = yield* OmpAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OMP_PROVIDER,
            instanceId,
            detail: "Failed to build omp orchestration adapter.",
            cause,
          }),
      ),
    );

    const checkProvider = checkOmpProviderStatus(effectiveConfig, processEnv, cwd).pipe(
      Effect.map(stampIdentity),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichPiSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OMP_PROVIDER,
            instanceId,
            detail: "Failed to build omp snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: OMP_PROVIDER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (workspaceCwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverOmpCommandsForCwd(effectiveConfig, processEnv, workspaceCwd).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: OMP_PROVIDER,
                      instanceId,
                      detail: "Failed to discover omp workspace commands.",
                      cause,
                    }),
                ),
              ),
            ]).pipe(
              Effect.map(([machineSnapshot, commands]) => ({
                ...machineSnapshot,
                ...commands,
                slashCommandsPending: false,
              })),
            ),
      orchestrationAdapter,
      textGeneration: makeUnsupportedTextGeneration(),
    } satisfies ProviderInstance;
  }),
};
