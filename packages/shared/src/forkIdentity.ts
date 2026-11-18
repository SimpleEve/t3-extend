/**
 * T3 Extend's identity, kept apart from official T3 Code so both can run on one machine without
 * sharing data, commands, services, URL schemes, or updates. Upstream files reference these values
 * on lines marked `// fork:`; `scripts/fork-identity-guard.ts` flags official literals that return.
 */
export const FORK = {
  appBaseName: "T3 Extend",
  /** The word that follows the fork mark in the in-app wordmark, which reads "T3 Extend". */
  wordmarkSuffix: "Extend",
  appId: "com.simpleeve.t3extend",
  userDataDir: "t3extend",
  userDataDirDev: "t3extend-dev",
  scheme: "t3extend",
  schemeDev: "t3extend-dev",
  schemePreview: "t3extend-preview",
  homeDirName: ".t3extend",
  cliCommand: "t3x",
  bootServiceName: "t3extend",
  bootServiceLabel: "com.simpleeve.t3extend.service",
  defaultPort: 3873,
  /** HTTPS port of the fork's Tailscale Serve route; official T3 Code takes 443 on the same tailnet name. */
  tailscaleServePort: 8443,
  /** First segment of the branch and ref names the fork writes into user repos; official T3 Code uses `t3` and `t3code`. */
  gitNamespace: "t3x",
  releaseRepository: "SimpleEve/t3-extend",
} as const;

/** Official T3 Code's HTTPS port on the tailnet name. The fork never publishes or removes a route on it. */
export const OFFICIAL_TAILSCALE_SERVE_PORT = 443;

/** How the official app is named in text the fork shows, so the brand guard has one place to allow. */
export const OFFICIAL_APP_NAME = "T3 Code";

/**
 * Where no user can be shown a message (stored settings, environment, bootstrap, flags), a 443
 * becomes the fork's own port. Typed input is rejected instead; see `tailscaleServePortProblem`.
 */
export const forkTailscaleServePort = (port: number): number =>
  port === OFFICIAL_TAILSCALE_SERVE_PORT ? FORK.tailscaleServePort : port;

/** SSH remote hosts default to official T3 Code's server archives, not the fork's. */
export const OFFICIAL_CLI_RELEASE_DOWNLOAD_URL =
  "https://github.com/pingdotgg/t3code/releases/download";

/** Official T3 Code's T3 home, read only: a fallback source for dev database seeding and the source of the data import. */
const OFFICIAL_HOME_DIR_NAME = ".t3";

/** App links from this fork and from official T3 Code, so either app's pairing QR code works. */
export const APP_LINK_PROTOCOL = /^(?:t3extend|t3code)(?:-[a-z]+)?:$/;

/** Official T3 Code's T3 home on this machine. Callers only ever read it. */
export const officialHomeDirectory = (
  homeDirectory: string,
  join: (...segments: string[]) => string,
): string => join(homeDirectory, OFFICIAL_HOME_DIR_NAME);

/** Fork home first, then official, newest-identity first. Callers only ever read these. */
export const devSeedHomeCandidates = (
  homeDirectory: string,
  join: (...segments: string[]) => string,
): ReadonlyArray<string> => [
  join(homeDirectory, FORK.homeDirName),
  officialHomeDirectory(homeDirectory, join),
];
