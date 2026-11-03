// fork: the one frp release T3 Extend runs (design Q7 / 8a). `frps` in infra/self-host and the `frpc`
// every computer launches must be the same version, so the pin lives here and a test holds the
// compose file to it. SHA-256 values are copied from the release's frp_sha256_checksums.txt.

export const FRP_VERSION = "0.71.1";

/** The `fatedier/frps` tag the compose file pins. */
export const FRPS_IMAGE_TAG = `v${FRP_VERSION}`;

export const FRP_RELEASE_BASE_URL = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`;

/** Replaces `FRP_RELEASE_BASE_URL` (a mirror holding the same file names). The SHA-256 check still applies. */
export const FRP_MIRROR_ENV = "T3X_FRP_BASE_URL";

export interface FrpArchive {
  readonly file: string;
  readonly sha256: string;
  /** The binary's name inside the archive's top-level directory. */
  readonly executable: "frpc" | "frpc.exe";
}

const archive = (suffix: string, sha256: string, executable: FrpArchive["executable"] = "frpc") =>
  ({ file: `frp_${FRP_VERSION}_${suffix}`, sha256, executable }) satisfies FrpArchive;

/** Keyed by `<process.platform>-<process.arch>`. */
export const FRP_ARCHIVES = {
  "darwin-arm64": archive(
    "darwin_arm64.tar.gz",
    "d15d0324b99e14619c9aa46e37f6db588c06a09be4bc6f7948890b6b61077842",
  ),
  "darwin-x64": archive(
    "darwin_amd64.tar.gz",
    "8acb59b6fb998cc8d209d1373d90bf70fa5ec3efeb4dfbc7bda6ce3abd78cb45",
  ),
  "linux-x64": archive(
    "linux_amd64.tar.gz",
    "1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803",
  ),
  "linux-arm64": archive(
    "linux_arm64.tar.gz",
    "8edf590b0c396fa42f9c147121a76af83cfc2002b08f5aef0ea1008c43482019",
  ),
  "linux-arm": archive(
    "linux_arm.tar.gz",
    "8eb6fe66a3b36db24ca0de44fb01e6742d0ff60e30f462c9662f41813bbf4376",
  ),
  "win32-x64": archive(
    "windows_amd64.zip",
    "b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821",
    "frpc.exe",
  ),
  "win32-arm64": archive(
    "windows_arm64.zip",
    "6c25afb4058f7708937db7064836fec593e941de0e6c2c255982335a9b16d370",
    "frpc.exe",
  ),
} as const satisfies Record<string, FrpArchive>;

export type FrpPlatformKey = keyof typeof FRP_ARCHIVES;

export const frpArchiveFor = (platform: string, arch: string): FrpArchive | undefined => {
  const key = `${platform}-${arch}`;
  return Object.hasOwn(FRP_ARCHIVES, key) ? FRP_ARCHIVES[key as FrpPlatformKey] : undefined;
};

/** `baseUrl` is the mirror override when one is set; a trailing slash is ignored. */
export const frpArchiveUrl = (entry: FrpArchive, baseUrl?: string): string =>
  `${(baseUrl ?? FRP_RELEASE_BASE_URL).replace(/\/+$/, "")}/${entry.file}`;

/** The top-level directory the archive extracts to: the file name without its extension. */
export const frpArchiveDirectory = (entry: FrpArchive): string =>
  entry.file.replace(/\.(tar\.gz|zip)$/, "");
