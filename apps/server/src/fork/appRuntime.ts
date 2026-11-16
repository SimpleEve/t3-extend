// fork: the packaged macOS app's `t3x` shim runs its executable on the asar server entry as plain
// Node (ELECTRON_RUN_AS_NODE). A service installed from that CLI runs the same pair, so it needs
// no downloaded runtime. Plain values in, so the Effect-free launcher can share it.
export interface AppRuntime {
  /** The `.app` bundle. */
  readonly appPath: string;
  /** Electron's executable, run as plain Node. */
  readonly executable: string;
  /** The server entry inside `app.asar`. */
  readonly entry: string;
  readonly frpc: string;
}

const APP_SERVER_ENTRY =
  /^(.+\.app)\/Contents\/Resources\/app\.asar\/apps\/server\/dist\/bin\.mjs$/;

/** Only the packaged macOS app; other platforms and installs keep the downloaded-runtime service. */
export function detectAppRuntime(input: {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): AppRuntime | undefined {
  if (input.platform !== "darwin" || input.env.ELECTRON_RUN_AS_NODE !== "1") return undefined;
  const entry = input.argv[1];
  const appPath = entry === undefined ? undefined : APP_SERVER_ENTRY.exec(entry)?.[1];
  if (entry === undefined || appPath === undefined) return undefined;
  if (!input.execPath.startsWith(`${appPath}/Contents/MacOS/`)) return undefined;
  const frpc = input.env.T3X_FRPC_PATH?.trim();
  return {
    appPath,
    executable: input.execPath,
    entry,
    frpc: frpc || `${appPath}/Contents/Resources/bin/frpc`,
  };
}

/** The plist records the app version it was installed from; the launcher runs the app only as that version. */
export const APP_RUNTIME_VERSION_ENV = "T3X_APP_RUNTIME_VERSION";

/** Only a plist with this variable is the app's own service; nothing else may be stopped for the app. */
const APP_SERVICE_MARKER_ENV = "T3X_APP_SERVICE";

/** What the service's plist adds so the launcher and the server it starts run as the app does. */
export const appRuntimeEnvironment = (
  runtime: AppRuntime,
  version: string,
): ReadonlyArray<readonly [name: string, value: string]> => [
  [APP_SERVICE_MARKER_ENV, "1"],
  ["ELECTRON_RUN_AS_NODE", "1"],
  ["T3X_FRPC_PATH", runtime.frpc],
  [APP_RUNTIME_VERSION_ENV, version],
];

const isTransientPath = (path: string) =>
  path.includes("/AppTranslocation/") || path.startsWith("/Volumes/");

/**
 * A disk image or a translocated copy is gone after a reboot, and a bundle whose executable or
 * asar is a link out of it is not the app it names. `real` holds the paths after resolving links.
 */
export function appLocationProblem(real: {
  readonly appPath: string;
  readonly executable: string;
  readonly asar: string;
}): "transient" | "mismatch" | undefined {
  const inside = (path: string) => path.startsWith(`${real.appPath}/`);
  if (!inside(real.executable) || !inside(real.asar)) return "mismatch";
  return isTransientPath(real.appPath) ? "transient" : undefined;
}

const unescapeXmlText = (value: string) =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** The app a launch agent runs, or undefined for a plist that runs a downloaded runtime. */
export function parseAppRuntimeUnit(
  contents: string,
): { readonly executable: string; readonly entry: string } | undefined {
  if (!new RegExp(`<key>${APP_SERVICE_MARKER_ENV}</key>\\s*<string>1</string>`).test(contents)) {
    return undefined;
  }
  const program =
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>/.exec(
      contents,
    );
  return program === null
    ? undefined
    : { executable: unescapeXmlText(program[1]!), entry: unescapeXmlText(program[2]!) };
}
