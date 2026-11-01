import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  encodePublicUrlsDocument,
  normalizePublicUrls,
  parsePublicUrlList,
  parsePublicUrlsDocument,
  PUBLIC_URLS_ENV,
  PUBLIC_URLS_FILE_ENV,
  PUBLIC_URLS_FILE_NAME,
  type SelfHostState,
} from "@t3tools/shared/selfHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ManagedTunnel from "./ManagedTunnel.ts";

const TUNNEL_SETTINGS_FILE_NAME = "self-host-tunnel.json";
// The tunnel command runs on this machine, so other local users must not edit it.
const SETTINGS_FILE_MODE = 0o600;
const SETTINGS_DIRECTORY_MODE = 0o700;
const MAX_COMMAND_LENGTH = 2_000;

const TunnelSettingsDocument = Schema.Struct({
  command: Schema.String,
  enabled: Schema.Boolean,
});
const TunnelSettingsJson = Schema.fromJsonString(TunnelSettingsDocument);
const decodeTunnelSettings = Schema.decodeUnknownOption(TunnelSettingsJson);
const encodeTunnelSettings = Schema.encodeSync(TunnelSettingsJson);

export class DesktopSelfHostWriteError extends Schema.TaggedError<DesktopSelfHostWriteError>()(
  "DesktopSelfHostWriteError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to save self-hosted connection settings to ${this.path}.`;
  }
}

/**
 * Settings for reaching this desktop through the user's own server: public
 * HTTPS addresses (also read by the backend, so paired devices learn them)
 * and the managed tunnel command. Desktop-local; only the desktop renderer's
 * preload bridge reaches it.
 */
export class DesktopSelfHost extends Context.Service<
  DesktopSelfHost,
  {
    readonly getState: Effect.Effect<SelfHostState>;
    /** Saved addresses plus the environment's, as pairing endpoints. */
    readonly publicUrls: Effect.Effect<ReadonlyArray<string>>;
    readonly setPublicUrls: (
      urls: ReadonlyArray<string>,
    ) => Effect.Effect<SelfHostState, DesktopSelfHostWriteError>;
    readonly setTunnel: (input: {
      readonly command: string;
      readonly enabled: boolean;
    }) => Effect.Effect<SelfHostState, DesktopSelfHostWriteError>;
    readonly restartTunnel: Effect.Effect<SelfHostState>;
    readonly changes: Stream.Stream<SelfHostState>;
  }
>()("@t3tools/desktop/selfHost/DesktopSelfHost") {}

/** The backend reads saved addresses from this file on every config request. */
export const publicUrlsFilePath = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  environment.path.join(environment.stateDir, PUBLIC_URLS_FILE_NAME);

/** Env for the primary backend: where saved addresses live, and the ones set by env. */
export const backendEnvironment = (input: {
  readonly publicUrlsFile: string;
  readonly environmentPublicUrls: ReadonlyArray<string>;
}): Record<string, string> => ({
  [PUBLIC_URLS_FILE_ENV]: input.publicUrlsFile,
  ...(input.environmentPublicUrls.length === 0
    ? {}
    : { [PUBLIC_URLS_ENV]: input.environmentPublicUrls.join(",") }),
});

/** `T3CODE_DESKTOP_HTTPS_ENDPOINTS` and `T3CODE_PUBLIC_URLS`, HTTPS origins only. */
export const readEnvironmentPublicUrls = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const environment = yield* HostProcess.Environment;
  return normalizePublicUrls([
    ...config.desktopHttpsEndpointUrls,
    ...parsePublicUrlList(environment[PUBLIC_URLS_ENV]),
  ]);
}).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const tunnel = yield* ManagedTunnel.ManagedTunnel;
  const environmentPublicUrls = yield* readEnvironmentPublicUrls;
  const permit = yield* Semaphore.make(1);
  const publicUrlsFile = publicUrlsFilePath(environment);
  const tunnelFile = environment.path.join(environment.stateDir, TUNNEL_SETTINGS_FILE_NAME);

  const readSavedPublicUrls = fs.readFileString(publicUrlsFile).pipe(
    Effect.map(parsePublicUrlsDocument),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const writeAtomically = Effect.fn("desktop.selfHost.write")(function* (
    path: string,
    content: string,
  ) {
    const tempPath = `${path}.${process.pid}.tmp`;
    yield* fs
      .makeDirectory(environment.stateDir, { recursive: true, mode: SETTINGS_DIRECTORY_MODE })
      .pipe(
        Effect.andThen(fs.writeFileString(tempPath, content, { mode: SETTINGS_FILE_MODE })),
        // `mode` applies only on creation, and a leftover temp file keeps its old mode.
        Effect.andThen(fs.chmod(tempPath, SETTINGS_FILE_MODE)),
        Effect.andThen(fs.rename(tempPath, path)),
        Effect.mapError((cause) => new DesktopSelfHostWriteError({ path, cause })),
      );
  });

  const getState = Effect.gen(function* () {
    return {
      publicUrls: yield* readSavedPublicUrls,
      environmentPublicUrls,
      tunnel: yield* tunnel.state,
    } satisfies SelfHostState;
  });

  const setPublicUrls = Effect.fn("desktop.selfHost.setPublicUrls")(function* (
    urls: ReadonlyArray<string>,
  ) {
    yield* writeAtomically(publicUrlsFile, encodePublicUrlsDocument(urls));
    return yield* getState;
  }, permit.withPermit);

  const setTunnel = Effect.fn("desktop.selfHost.setTunnel")(function* (input: {
    readonly command: string;
    readonly enabled: boolean;
  }) {
    const command = input.command.trim().slice(0, MAX_COMMAND_LENGTH);
    const enabled = input.enabled && command.length > 0;
    yield* writeAtomically(tunnelFile, `${encodeTunnelSettings({ command, enabled })}\n`);
    yield* tunnel.configure({ command, enabled });
    return yield* getState;
  }, permit.withPermit);

  const restartTunnel = tunnel.restart.pipe(
    Effect.andThen(getState),
    Effect.withSpan("desktop.selfHost.restartTunnel"),
  );

  // Starts the saved tunnel with the app; the tunnel's scope stops it on quit.
  const savedTunnel = yield* fs.readFileString(tunnelFile).pipe(
    Effect.map(decodeTunnelSettings),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isSome(savedTunnel)) yield* tunnel.configure(savedTunnel.value);

  return DesktopSelfHost.of({
    getState,
    publicUrls: readSavedPublicUrls.pipe(
      Effect.map((saved) => normalizePublicUrls([...environmentPublicUrls, ...saved])),
    ),
    setPublicUrls,
    setTunnel,
    restartTunnel,
    changes: tunnel.changes.pipe(Stream.mapEffect(() => getState)),
  });
});

export const layer = Layer.effect(DesktopSelfHost, make).pipe(Layer.provide(ManagedTunnel.layer));
