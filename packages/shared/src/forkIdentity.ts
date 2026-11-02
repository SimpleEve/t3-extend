/**
 * T3 Extend's identity, kept apart from official T3 Code so both can run on one machine without
 * sharing data, commands, services, URL schemes, or updates. Upstream files reference these values
 * on lines marked `// fork:`; `scripts/fork-identity-guard.ts` flags official literals that return.
 */
export const FORK = {
  appBaseName: "T3 Extend",
  /** The word that follows the T3 glyph in the in-app wordmark. */
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
  releaseRepository: "SimpleEve/t3-extend",
} as const;

/** SSH remote hosts get official T3 Code's server; the fork publishes no server archives. */
export const OFFICIAL_CLI_RELEASE_DOWNLOAD_URL =
  "https://github.com/pingdotgg/t3code/releases/download";

/** Official T3 Code's T3 home, read only as a fallback source for dev database seeding. */
const OFFICIAL_HOME_DIR_NAME = ".t3";

/** App links from this fork and from official T3 Code, so either app's pairing QR code works. */
export const APP_LINK_PROTOCOL = /^(?:t3extend|t3code)(?:-[a-z]+)?:$/;

/** Fork home first, then official, newest-identity first. Callers only ever read these. */
export const devSeedHomeCandidates = (
  homeDirectory: string,
  join: (...segments: string[]) => string,
): ReadonlyArray<string> => [
  join(homeDirectory, FORK.homeDirName),
  join(homeDirectory, OFFICIAL_HOME_DIR_NAME),
];
