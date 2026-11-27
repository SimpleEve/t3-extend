import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  AntigravitySettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderSetupError,
  RuntimeMode,
  settingsSecretLiteral,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  NodeRuntimeUnavailableError,
  nodeRuntimeUnavailableMessage,
} from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";
import * as AcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import {
  runSharedLoginCheck,
  SHARED_LOGIN_CHECK_TIMEOUT_MS,
  type SharedLoginOutcome,
} from "../antigravitySharedLoginCheck.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import { brokenRuntimeError } from "../providerCompatibility.ts";
import * as AntigravityUsage from "./AntigravityUsage.ts";
import {
  ANTIGRAVITY_CLI_LOGIN_SIGN_OUT_MESSAGE,
  antigravityAuthConfigIssue,
  antigravityAuthLabel,
  antigravityAuthUsesBrowser,
  antigravityProfileLoginUsed,
  antigravityProfileTokenExists, // fork:
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  markAntigravityProfileLogin,
  prepareAntigravityProfile,
  resolveAntigravityInstanceDirectories,
  resolveAntigravityLoginSource,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";
import {
  antigravityModelOptions,
  antigravityServesT3Code,
  antigravitySessionMode,
  antigravityThinkingConfig,
  makeAntigravityAcpRuntime,
  OPEN_MODEL_ACCESS_RELEASE,
  type AntigravityAcpRuntimeInput,
} from "../acp/AntigravityAcpSupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  removeAntigravitySessionFiles,
  retireAntigravityRuntimeTempDirs,
} from "../acp/AntigravitySessionFiles.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  makeAntigravityAdapterV2,
  type AntigravityAdapterV2RuntimeInput,
} from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityProvider } from "../AntigravityProvider.ts";
import {
  makeAntigravityCliLoginReader,
  AntigravityCliLoginSource,
} from "../antigravityCliLogin.ts"; // fork:
import { makeAntigravityUsageProbe } from "../antigravityUsageLimits.ts";
import { makeAntigravityProxyDispatcher } from "../antigravityNetworkProxy.ts"; // fork:
import { syncAntigravityGlobalMcp } from "../antigravityGlobalMcp.ts"; // fork:
import {
  makeAntigravityAccountPool,
  type AntigravityAccountPoolError,
} from "../antigravityAccountPool.ts"; // fork:
import {
  makeAntigravityAccountProber,
  makeAntigravityAccountReader,
  startAntigravityBackgroundProbe,
} from "../antigravityBackgroundProbe.ts"; // fork:
import { antigravityServerAccounts } from "../antigravityAccountRotation.ts"; // fork:
import { makeAntigravityUsageLimitRecovery } from "../antigravityAccountRotation.ts"; // fork:
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const isNodeRuntimeUnavailableError = Schema.is(NodeRuntimeUnavailableError);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isProviderSetupError = Schema.is(ProviderSetupError);
const isAcpErrorDetails = Schema.is(Schema.Struct({ details: Schema.String }));
const RememberedRuntimeModes = Schema.fromJsonString(
  Schema.Struct({ authMethod: Schema.String, modes: Schema.Array(RuntimeMode) }),
);
const decodeRememberedRuntimeModes = Schema.decodeUnknownOption(RememberedRuntimeModes);
const encodeRememberedRuntimeModes = Schema.encodeSync(RememberedRuntimeModes);
const REFRESH_FAILED =
  "Could not refresh Antigravity models. The previous model list is unchanged.";
const PYTHON_SOCKS_REQUIRED = "python-socks is required to use a SOCKS proxy";
// fork: an agent start per check would be wasteful, so a signed-out CLI is asked again this often.
const SHARED_SIGN_IN_RECHECK_MS = 5 * 60_000;
// An agent that could not answer is tried again sooner, since nothing is known about the account.
const SHARED_SIGN_IN_RETRY_MS = 60_000;

// Keep upstream diagnostics in cause; only recognized, fixed text reaches clients.
function refreshFailureDetail(cause: unknown) {
  return isAcpRequestError(cause) &&
    cause.operation === "receive-response" &&
    isAcpErrorDetails(cause.data) &&
    cause.data.details.includes(PYTHON_SOCKS_REQUIRED)
    ? `${REFRESH_FAILED} Antigravity reported: ${PYTHON_SOCKS_REQUIRED}`
    : REFRESH_FAILED;
}

export type AntigravityDriverEnv =
  | AntigravityInstallation.AntigravityInstallation
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const AntigravityDriver: ProviderDriver<
  AntigravitySettings,
  AntigravityDriverEnv,
  AntigravityUsage.AntigravityUsage
> = {
  driverKind: DRIVER,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  usage: AntigravityUsage.antigravityUsageReader,
  create: Effect.fn("AntigravityDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const digest = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
    const fileSystem = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const selfInvocation = yield* resolveSelfInvocation();
    const installation = yield* AntigravityInstallation.AntigravityInstallation;
    const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER);
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    const settings = { ...config, enabled } satisfies AntigravitySettings;
    const auth: AntigravityAuthConfig = {
      authMethod: settings.authMethod,
      // The instance registry has already read a referenced key from its secret provider.
      apiKey: settingsSecretLiteral(settings.apiKey),
      gcpProject: settings.gcpProject,
      gcpLocation: settings.gcpLocation,
      networkProxy: settings.networkProxy, // fork:
    };
    const authConfigIssue = antigravityAuthConfigIssue(auth);
    const processEnvironment = yield* mergeProviderInstanceEnvironment(environment);
    const userHome = resolveAntigravityUserHome(
      yield* HostProcess.Platform,
      processEnvironment,
      yield* HostProcess.HomeDirectory,
    );
    const directories = yield* resolveAntigravityInstanceDirectories(
      host.paths.stateDir,
      instanceId,
    ).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not resolve the Antigravity profile directory.",
            cause,
          }),
      ),
    );
    const profileDirectory = directories.profile;
    // fork: switching the setting off removes its config copy and links now, not at the next agy launch.
    yield* syncAntigravityGlobalMcp({
      profileDirectory,
      userHome,
      platform: yield* HostProcess.Platform,
      enabled: settings.useGlobalMcp,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    // fork: the default instance signs in from the agy CLI's own login instead of asking again.
    const sharedLogin =
      resolveAntigravityLoginSource({
        authMethod: auth.authMethod,
        loginSource: settings.loginSource,
        defaultInstance: instanceId === defaultInstanceIdForDriver(DRIVER),
        profileLoginUsed: yield* antigravityProfileLoginUsed(profileDirectory).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      }) === "cli";
    // fork: remember that this profile signed in on its own, so `auto` never switches it to the CLI.
    const rememberProfileLogin = markAntigravityProfileLogin(profileDirectory).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    if (
      !sharedLogin &&
      antigravityAuthUsesBrowser(auth.authMethod) &&
      (yield* antigravityProfileTokenExists(profileDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ))
    ) {
      yield* rememberProfileLogin;
    }
    // fork: reads started by a session outlive it, but not the instance.
    const instanceScope = yield* Effect.scope;
    // fork: several saved Google accounts, only for an instance that signs in on its own.
    const accountPool =
      !sharedLogin && auth.authMethod === "oauth-personal"
        ? yield* makeAntigravityAccountPool(profileDirectory).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Digest.Digest, digest),
          )
        : undefined;
    // Only a session reports whether agy offers Auto, so keep the last answer across restarts.
    const runtimeModesPath = path.join(profileDirectory, "t3-runtime-modes.json");
    const rememberedRuntimeModes = yield* fileSystem.readFileString(runtimeModesPath).pipe(
      Effect.map((contents) =>
        decodeRememberedRuntimeModes(contents).pipe(
          Option.filter((saved) => saved.authMethod === auth.authMethod),
          Option.map((saved) => saved.modes),
          Option.getOrUndefined,
        ),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const directory of [
      directories.runtimeTemp,
      path.join(profileDirectory, "antigravity-acp", "tmp"),
    ]) {
      const removeRetired = yield* retireAntigravityRuntimeTempDirs(directory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      yield* Effect.forkScoped(removeRetired);
    }
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const classifyModels = (draft: ServerProviderDraft) =>
      currentCatalog.pipe(
        Effect.map((catalog) => stampIdentity(ModelCatalog.applyModelCatalog(draft, catalog))),
      );

    const prepareSpawn = Effect.fn("AntigravityDriver.prepareSpawn")(function* (
      cwd: string,
      baseEnv: NodeJS.ProcessEnv,
    ): Effect.fn.Return<
      {
        readonly executable: AntigravityInstallation.AntigravityExecutable;
        readonly spawn: AcpSessionRuntime.AcpSpawnInput;
      },
      AcpErrors.AcpError | ProviderSetupError,
      Scope.Scope
    > {
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const executable = yield* installation.acquire(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      // fork: with the old agy gone, the account that takes over is put in place before the new one starts.
      if (accountPool) {
        const { swapped, spent } = yield* accountPool
          .ensureAvailable({ rotate: settings.accountRotation })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not prepare the Antigravity account.", { cause }).pipe(
                Effect.as({ swapped: false, spent: undefined }),
              ),
            ),
          );
        // The quota on screen belonged to the account that was just replaced.
        if (swapped) yield* Effect.suspend(() => provider.onSignedIn);
        // Its last reading predates running out, so it cannot say which window did; read it now.
        if (spent !== undefined && accountProber) {
          yield* Effect.forkIn(accountProber.probe(spent), instanceScope);
        }
      }
      const profile = yield* prepareAntigravityProfile({
        profileDirectory,
        baseEnv: processEnvironment,
        auth,
        userHome,
        tempDirectory: directories.runtimeTemp,
        sharedLogin, // fork:
        globalMcp: settings.useGlobalMcp, // fork:
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) =>
          isNodeRuntimeUnavailableError(cause.cause)
            ? new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: nodeRuntimeUnavailableMessage("Antigravity sign-in"),
                cause,
              })
            : cause,
        ),
      );
      // Use one directory per process; shared cleanup could delete files another session still reads.
      // Remove after the child dies, best-effort on Windows where handles may outlive the kill;
      // the next driver start sweeps leftovers.
      const runtimeTempDirectory = yield* Effect.acquireRelease(
        fileSystem.makeTempDirectory({ directory: profile.tempDirectory, prefix: "run-" }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity runtime temp directory.",
                cause,
              }),
          ),
        ),
        (directory) =>
          fileSystem
            .remove(directory, { recursive: true, force: true })
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not remove an Antigravity runtime temp directory."),
              ),
            ),
      );
      return {
        executable,
        spawn: buildAntigravityAcpSpawnInput({
          installation: executable,
          profile,
          cwd,
          baseEnv,
          auth,
          runtimeTempDirectory,
        }),
      };
    });

    const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
      input: AntigravityAdapterV2RuntimeInput,
    ): Effect.fn.Return<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      AcpErrors.AcpError | ProviderSetupError,
      Scope.Scope
    > {
      // `buildAntigravityAcpSpawnInput` sets `extendEnv: false`, so thread variables only reach the
      // agent's shell through `baseEnv`.
      const { processEnvironment: threadEnvironment, ...runtimeInput } = input;
      const { executable, spawn } = yield* prepareSpawn(
        runtimeInput.cwd,
        threadEnvironment === undefined
          ? processEnvironment
          : { ...processEnvironment, ...threadEnvironment },
      );
      const runtime = yield* makeAntigravityAcpRuntime({
        ...runtimeInput,
        authMethod: auth.authMethod,
        childProcessSpawner: spawner,
        spawn,
      }).pipe(Effect.provideService(SecureRandom.SecureRandom, random));
      // A custom or PATH executable has no version until it answers initialize.
      const startCompatible = Effect.fn("AntigravityDriver.startCompatible")(function* () {
        const version = (yield* runtime.initialize()).agentInfo?.version;
        const advisory = version ? yield* installation.compatibility(version) : undefined;
        const action =
          executable.source === "managed"
            ? "Update it in Antigravity setup"
            : `Update the Antigravity executable at ${executable.executablePath}`;
        const refused = !version
          ? undefined
          : (brokenRuntimeError({ instanceId, name: "Antigravity", version, advisory, action }) ??
            (antigravityServesT3Code(version)
              ? undefined
              : new ProviderSetupError({
                  instanceId,
                  operation: "runtime",
                  detail: `Antigravity ${version} only serves allowlisted editors, not T3 Code. ${action} to ${OPEN_MODEL_ACCESS_RELEASE.join(".")} or newer, then retry.`,
                })));
        if (refused) {
          return yield* new AcpErrors.AcpTransportError({ detail: refused.detail, cause: refused });
        }
        return yield* runtime.start();
      });
      return {
        ...runtime,
        setMode: (modeId: string) =>
          runtime.getModeState.pipe(
            Effect.flatMap((modeState) =>
              runtime.setMode(antigravitySessionMode(modeId, modeState)),
            ),
          ),
        start: () =>
          startCompatible().pipe(
            Effect.tapError((cause): Effect.Effect<void> =>
              runtimeInput.onAuthorizationUrl === undefined &&
              isAntigravitySignInRequiredError(cause)
                ? provider.onAuthRequired
                : Effect.void,
            ),
          ),
      };
    });

    const makeDisposableRuntime = Effect.fn("AntigravityDriver.makeDisposableRuntime")(function* (
      input: Pick<AntigravityAcpRuntimeInput, "onAuthorizationUrl">,
    ) {
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity setup workspace.",
              }),
          ),
        );
      let sessionId: string | undefined;
      yield* Effect.addFinalizer(() =>
        removeAntigravitySessionFiles({
          profileDirectory,
          sessionId,
          cwd,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const runtime = yield* makeRuntime({
        cwd,
        mcpServers: [],
        ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
      });
      return {
        ...runtime,
        start: () =>
          runtime.start().pipe(
            Effect.tap((started) =>
              Effect.sync(() => {
                sessionId = started.sessionId;
              }),
            ),
          ),
      };
    });

    // The agy CLI ignores T3's browser helper during ACP `authenticate`, so Google sign-in runs its
    // remote-friendly `--login`, which stores the sign-in where the ACP process reads it.
    const codeLogin = Effect.fn("AntigravityDriver.codeLogin")(function* (input: {
      readonly onAuthorizationUrl: (url: string) => Effect.Effect<void, AcpErrors.AcpError>;
    }) {
      if (auth.authMethod !== "oauth-personal") return undefined;
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-antigravity-login-" })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity setup workspace.",
              }),
          ),
        );
      const { spawn } = yield* prepareSpawn(cwd, processEnvironment);
      const failed = (detail: string, cause?: unknown) =>
        new ProviderSetupError({ instanceId, operation: "start", detail, cause });
      // fork: a sign-in adds an account. The current one is saved first so agy asks for Google again,
      // and whatever `--login` left, or the saved account if it left nothing, is registered at the end.
      if (accountPool) {
        yield* accountPool.beginAdd.pipe(Effect.mapError((cause) => failed(cause.detail, cause)));
        yield* Effect.addFinalizer(() =>
          accountPool.settleAdd.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not save the Antigravity account.", { cause }),
            ),
          ),
        );
      }
      // Without a display it prints the link only, instead of opening a browser on this machine.
      const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...env } = spawn.env ?? {};
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawn.command, [...spawn.args, "--login"], {
            cwd,
            env,
            extendEnv: false,
            shell: false,
          }),
        )
        .pipe(Effect.mapError((cause) => failed("Could not start Antigravity sign-in.", cause)));
      const code = yield* Deferred.make<string>();
      yield* Stream.fromEffect(Deferred.await(code)).pipe(
        Stream.map((response) => `${response}\n`),
        Stream.encodeText,
        Stream.run(child.stdin),
        Effect.ignore,
        Effect.forkScoped,
      );
      const output = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.map((line) => line.trim()),
        Stream.runForEach((line) =>
          line.startsWith("https://accounts.google.com/")
            ? input.onAuthorizationUrl(line)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkScoped);
      return {
        submit: (response: string) => Deferred.succeed(code, response).pipe(Effect.asVoid),
        completed: Effect.gen(function* () {
          // Stdout closes when the process exits, or this fails first on an unusable link.
          yield* Fiber.join(output).pipe(
            Effect.mapError((cause) =>
              failed("Antigravity returned an invalid Google sign-in link.", cause),
            ),
          );
          const exitCode = yield* child.exitCode.pipe(
            Effect.mapError((cause) => failed("Antigravity sign-in stopped unexpectedly.", cause)),
          );
          if (Number(exitCode) !== 0) {
            return yield* failed(
              "Antigravity could not finish Google sign-in. Start sign-in again.",
            );
          }
        }),
      };
    });

    const publishCatalog = Effect.fn("AntigravityDriver.publishCatalog")(function* (
      started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
      runtime: Pick<
        AcpSessionRuntime.AcpSessionRuntime["Service"],
        "getEvents" | "drainEvents" | "setModel"
      >,
    ) {
      yield* provider.onSessionStarted(started);
      yield* authFlow.onSignedInElsewhere;
      yield* Stream.runForEach(runtime.getEvents(), (event) => {
        if (event._tag === "EventStreamBarrier") {
          return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
        }
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions, { fromCatalogProbe: true });
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands)
          : Effect.void;
      }).pipe(Effect.forkScoped);
      // Thinking levels differ per model and are reported only for the selected one.
      const configOptions = started.sessionSetupResult.configOptions ?? [];
      const current = configOptions.find((option) => option.id === "model")?.currentValue;
      if (antigravityThinkingConfig(configOptions) !== undefined && typeof current === "string") {
        for (const model of [...antigravityModelOptions(configOptions), { value: current }]) {
          yield* runtime.setModel(model.value).pipe(Effect.ignore);
        }
      }
      yield* runtime.drainEvents;
    }, Effect.scoped);

    // fork: a change of account replaces the quota on screen and the list of accounts.
    const accountChange = (
      operation: string,
      change: Effect.Effect<void, AntigravityAccountPoolError>,
    ) =>
      change.pipe(
        Effect.mapError(
          (cause) => new ProviderSetupError({ instanceId, operation, detail: cause.detail, cause }),
        ),
        Effect.andThen(Effect.suspend(() => provider.onSignedIn)),
      );
    const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
      instanceId,
      makeRuntime: makeDisposableRuntime,
      // A new sign-in may be another account; drop any in-flight quota read first.
      onAuthenticated: (started, runtime) =>
        Effect.suspend(() => provider.onSignedIn).pipe(
          Effect.andThen(sharedLogin ? Effect.void : rememberProfileLogin), // fork:
          Effect.andThen(publishCatalog(started, runtime)),
        ),
      // fork: signing out leaves no saved account behind.
      onSignedOut: Effect.suspend(() => provider.onSignedOut).pipe(
        Effect.andThen(
          accountPool?.clear.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not remove the saved Antigravity accounts.", { cause }),
            ),
          ) ?? Effect.void,
        ),
      ),
      ...(accountPool
        ? {
            selectMethod: (methodId: string) =>
              accountChange("selectMethod", accountPool.select(methodId)),
            removeMethod: (methodId: string) =>
              accountChange("removeMethod", accountPool.remove(methodId)),
          }
        : {}),
      // fork: reading another account never touches the one agy runs on, so nothing stops. Only
      // with quota reading on; the prober exists only then.
      ...(accountPool && settings.readUsageLimits
        ? {
            refreshAccounts: (methodId?: string) =>
              Effect.suspend(() => accountProber!.refresh(methodId)),
          }
        : {}),
      usesBrowser: antigravityAuthUsesBrowser(auth.authMethod),
      // fork: a shared CLI login signs in through ACP, so the keyring entry stays the CLI's.
      ...(sharedLogin
        ? { logoutBlockedMessage: ANTIGRAVITY_CLI_LOGIN_SIGN_OUT_MESSAGE }
        : { codeLogin }),
    });

    // The probe must not spawn. The agent is a PyInstaller one-file bundle
    // that unpacks about 1 GB per launch, and the health check runs every
    // minute.
    const probe = Effect.gen(function* () {
      yield* modelCatalog.refreshInBackground;
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const executable = yield* installation.resolve(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: {
          name: "antigravity-acp",
          title: "Google Antigravity",
          version: executable.version ?? "unknown",
        },
      };
    });

    const cliLoginSource = yield* AntigravityCliLoginSource; // fork:
    const cliLoginRead = makeAntigravityCliLoginReader({
      platform: cliLoginSource.platform ?? (yield* HostProcess.Platform),
      spawner,
    }); // fork:
    // fork: T3's own Google requests leave through the same proxy as agy.
    const proxyDispatcher = yield* makeAntigravityProxyDispatcher(settings.networkProxy);
    // fork: reading quota calls Google's cloudcode-pa API, which Google says can get an account
    // flagged, so nothing below that reads it exists unless the instance turns it on. Account
    // rotation does not need it: it works from the errors a turn reports.
    const readUsageLimits = settings.readUsageLimits;
    const usage = readUsageLimits
      ? yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: auth.authMethod,
          sharedLogin, // fork:
          readCliLogin: cliLoginRead && cliLoginSource.share(cliLoginRead), // fork:
          proxyDispatcher,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Digest.Digest, digest),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        )
      : undefined;
    // fork: the saved accounts that are not in use are read in the background, and on request.
    const accountProber =
      accountPool && readUsageLimits
        ? yield* makeAntigravityAccountProber({
            instanceId,
            pool: accountPool,
            read: yield* makeAntigravityAccountReader({
              // The lease a real session holds, so a reinstall cannot remove the binary in use.
              acquireExecutable: installation.acquire(settings.binaryPath, processEnvironment),
              baseEnv: processEnvironment,
              auth,
              userHome,
              tempRoot: directories.runtimeTemp,
              proxyDispatcher,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(Digest.Digest, digest),
              Effect.provideService(SecureRandom.SecureRandom, random),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
            // The provider is made below; the account list is republished once per finished read.
            onProbed: Effect.suspend(() => provider.onAccountsChanged),
            // A manual refresh stops with the instance, so it never outlives its proxy or pool.
            lifetime: yield* Effect.scope,
          })
        : undefined;
    const provider = yield* makeAntigravityProvider(settings, {
      environment: processEnvironment,
      stampIdentity: classifyModels,
      probe,
      ...(usage
        ? {
            probeUsage: accountPool ? accountPool.observeUsage(usage.probe) : usage.probe, // fork:
            clearUsage: usage.clear,
          }
        : {}),
      // fork: the health check never spawns the agent, so the stored token is its only sign-in signal.
      // A shared CLI login has no token here, so the agent is asked now and then instead.
      ...(sharedLogin
        ? { silentSignIn: Effect.suspend(() => silentSignIn) }
        : antigravityAuthUsesBrowser(auth.authMethod)
          ? {
              storedSignIn: antigravityProfileTokenExists(profileDirectory, true).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
            }
          : {}),
      auth: { type: auth.authMethod, label: antigravityAuthLabel(auth.authMethod) },
      // fork: the saved Google accounts of a separate sign-in.
      ...(accountPool
        ? { accounts: antigravityServerAccounts(accountPool, { readUsageLimits }) }
        : {}),
      ...(rememberedRuntimeModes ? { rememberedRuntimeModes } : {}),
      rememberRuntimeModes: (modes) =>
        writeFileStringAtomically({
          filePath: runtimeModesPath,
          contents: encodeRememberedRuntimeModes({ authMethod: auth.authMethod, modes }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.catch(() => Effect.logWarning("Could not save Antigravity permission modes.")),
        ),
      supportsTextGeneration: isAntigravityTextGenerationAvailable(profileDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => false),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not prepare the Antigravity provider status.",
            cause,
          }),
      ),
    );
    if (accountProber) {
      yield* startAntigravityBackgroundProbe({ enabled, settings, prober: accountProber });
    }
    const defaultModel = currentCatalog.pipe(Effect.map((catalog) => catalog?.defaultChatModel));
    const orchestrationAdapter = yield* makeAntigravityAdapterV2({
      instanceId,
      selfInvocation,
      makeRuntime,
      withProcess: authFlow.withProcess,
      defaultModel,
      supportsNativeGoals: provider.snapshot.getSnapshot.pipe(
        Effect.map(
          (snapshot) => snapshot.slashCommands?.some((command) => command.name === "goal") === true,
        ),
      ),
      profileDirectory,
      // fork: only with the setting on, and only for an instance that has several accounts to use.
      ...(accountPool && settings.accountRotation
        ? { recoverFromUsageLimit: makeAntigravityUsageLimitRecovery(accountPool) }
        : {}),
      onSessionStarted: (started, cwd, session) =>
        provider
          .onSessionStarted(started, cwd, session)
          .pipe(Effect.andThen(authFlow.onSignedInElsewhere)),
      onSessionEvent: (event, cwd) => {
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions);
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands, cwd)
          : Effect.void;
      },
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: loggers.native,
          provider: DRIVER,
          threadId,
        }),
    });
    const textGeneration = yield* makeAntigravityTextGeneration({
      profileDirectory,
      defaultModel,
      withProcess: authFlow.withProcess,
      makeRuntime: (cwd) =>
        makeRuntime({
          cwd,
          mcpServers: [],
        }),
    });

    const refreshModels = Effect.fn("AntigravityDriver.refreshModels")(
      function* () {
        const processScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
        yield* authFlow
          .withProcess(
            Scope.close(processScope, Exit.void),
            Effect.gen(function* () {
              const runtime = yield* makeDisposableRuntime({});
              const started = yield* runtime.start();
              yield* publishCatalog(started, runtime);
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, processScope));
      },
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "90 seconds",
        orElse: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Antigravity model refresh timed out. Try again or check Google sign-in.",
            }),
          ),
      }),
      Effect.tapError((cause) =>
        isAntigravitySignInRequiredError(cause) ? provider.onAuthRequired : Effect.void,
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderDriverError"
          ? cause
          : new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: isAntigravitySignInRequiredError(cause)
                ? "Sign in to Antigravity in provider settings before refreshing models."
                : cause._tag === "ProviderSetupError" &&
                    (cause.operation === "configure" ||
                      cause.operation === "resolve" ||
                      cause.operation === "start")
                  ? cause.detail
                  : cause._tag === "AcpTransportError" &&
                      isProviderSetupError(cause.cause) &&
                      cause.cause.operation === "runtime"
                    ? cause.cause.detail
                    : refreshFailureDetail(cause),
              cause,
            }),
      ),
    );

    // fork: asks the agent whether the CLI login works. It authenticates without a session and
    // without a browser, so a signed-out CLI only reports that sign-in is needed. Leaving the scope,
    // on the timeout too, stops the agent.
    let lastSharedSignInCheck:
      | { readonly at: number; readonly outcome: SharedLoginOutcome }
      | undefined;
    const checkSharedLogin: () => Effect.Effect<SharedLoginOutcome> = Effect.fn(
      "AntigravityDriver.checkSharedLogin",
    )(
      function* () {
        const processScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
        yield* authFlow
          .withProcess(
            Scope.close(processScope, Exit.void),
            Effect.gen(function* () {
              const runtime = yield* makeDisposableRuntime({});
              yield* runtime.authenticate?.(auth.authMethod) ?? Effect.void;
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, processScope));
        return "signed-in" as const;
      },
      Effect.scoped,
      Effect.timeoutOption(SHARED_LOGIN_CHECK_TIMEOUT_MS),
      Effect.map((outcome): SharedLoginOutcome =>
        outcome._tag === "Some" ? outcome.value : "unknown",
      ),
      Effect.catch((cause) =>
        Effect.succeed<SharedLoginOutcome>(
          isAntigravitySignInRequiredError(cause) ? "sign-in-required" : "unknown",
        ),
      ),
    );
    const silentSignIn: Effect.Effect<void> = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const last = lastSharedSignInCheck;
      if (
        last !== undefined &&
        now - last.at <
          (last.outcome === "unknown" ? SHARED_SIGN_IN_RETRY_MS : SHARED_SIGN_IN_RECHECK_MS)
      ) {
        return;
      }
      // Instances that share the CLI login share the answer; the executable names the keyring's owner.
      const executable = yield* installation
        .resolve(settings.binaryPath, processEnvironment)
        .pipe(Effect.option);
      if (executable._tag === "None") return;
      const outcome = yield* runSharedLoginCheck(
        executable.value.executablePath,
        checkSharedLogin(),
      );
      lastSharedSignInCheck = { at: yield* Clock.currentTimeMillis, outcome };
      if (outcome === "signed-in") yield* provider.onAuthConfirmed;
      else if (outcome === "sign-in-required") yield* provider.onAuthRequired;
      else yield* provider.onAuthUnknown;
    });

    return {
      instanceId,
      driverKind: DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: provider.snapshot,
      snapshotForCwd: (cwd) =>
        !enabled
          ? provider.snapshot.getSnapshot
          : discoverAntigravitySkills({ cwd, userHome, profileDirectory }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.flatMap((skills) => provider.snapshotForCwd(cwd, skills)),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER,
                    instanceId,
                    detail: "Could not read Antigravity workspace skills.",
                    cause,
                  }),
              ),
            ),
      orchestrationAdapter,
      textGeneration,
      auth: authFlow.controller,
      refreshModels,
    } satisfies ProviderInstance;
  }),
};
