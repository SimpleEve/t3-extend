// fork: fetch one frpc from the pinned release (forkFrp.ts), refuse it unless its SHA-256 matches the
// table, and put the executable where the caller asks. Plain async so `t3x devices tunnel install` and
// `scripts/fork-fetch-frp.ts` share it. A mirror (T3X_FRP_BASE_URL) changes where the bytes come
// from, never whether they are checked.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - a one-shot download and an unpack with `tar`.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as HostProcess from "./HostProcess.ts";

import {
  type FrpArchive,
  FRP_VERSION,
  frpArchiveDirectory,
  frpArchiveFor,
  frpArchiveUrl,
} from "./forkFrp.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ARCHIVE_SIZE_LIMIT = 100 * 1024 * 1024;
const VERSION_CHECK_TIMEOUT_MS = 10_000;

export type FrpFetchProblem =
  | "unsupported-platform"
  | "download-failed"
  | "checksum-mismatch"
  | "extract-failed";

// @effect-diagnostics-next-line extendsNativeError:off - fork: thrown from the plain-promise frpc downloader that the `t3x` launcher also runs outside Effect.
export class FrpFetchError extends Error {
  readonly problem: FrpFetchProblem;
  constructor(problem: FrpFetchProblem, message: string) {
    super(message);
    this.name = "FrpFetchError";
    this.problem = problem;
  }
}

const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** The cached archive's bytes if, read now, they hash to the pinned value; anything else is no cache. */
const readPinnedArchive = async (cachePath: string, pinned: string) => {
  const cached = await NodeFSP.readFile(cachePath).catch(() => undefined);
  return cached !== undefined && sha256Hex(cached) === pinned ? cached : undefined;
};

/** Best effort: a cache that cannot be written only costs the next run a download. */
const storeArchive = async (cachePath: string, bytes: Parameters<typeof sha256Hex>[0]) => {
  const partial = `${cachePath}.${process.pid}.${NodeCrypto.randomBytes(8).toString("hex")}.partial`;
  try {
    await NodeFSP.mkdir(NodePath.dirname(cachePath), { recursive: true });
    await NodeFSP.writeFile(partial, bytes, { mode: 0o644 });
    await NodeFSP.rename(partial, cachePath);
  } catch {
    await NodeFSP.rm(partial, { force: true }).catch(() => undefined);
  }
};

/**
 * Downloads the archive for `platform`/`arch`, checks it, unpacks it in a private temporary
 * directory and moves the executable to `<destination>/<frpc|frpc.exe>`. Nothing is written to
 * `destination` unless the checksum matched.
 */
export const fetchFrpc = async (input: {
  readonly platform: string;
  readonly arch: string;
  readonly destination: string;
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  /** Tests only: expect this archive instead of the pinned one for the platform. */
  readonly entry?: FrpArchive;
  /**
   * Where the verified archive is kept between runs. A file there is used only if its bytes match the
   * pinned SHA-256 now; it is never trusted for having been put there, and frpc is unpacked from it
   * afresh every time. Without this option every call downloads.
   */
  readonly archiveCacheDir?: string;
}): Promise<{
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly fromCache: boolean;
}> => {
  const entry = input.entry ?? frpArchiveFor(input.platform, input.arch);
  if (entry === undefined) {
    throw new FrpFetchError(
      "unsupported-platform",
      `There is no frpc build for ${input.platform}/${input.arch}.`,
    );
  }
  const url = frpArchiveUrl(entry, input.baseUrl);
  const doFetch = input.fetch ?? globalThis.fetch;

  const download = async () => {
    let bytes: Uint8Array;
    try {
      const response = await doFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        throw new FrpFetchError("download-failed", `The download answered ${response.status}.`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > ARCHIVE_SIZE_LIMIT) {
        throw new FrpFetchError("download-failed", "The download is larger than expected.");
      }
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > ARCHIVE_SIZE_LIMIT) {
        throw new FrpFetchError("download-failed", "The download is larger than expected.");
      }
    } catch (cause) {
      if (cause instanceof FrpFetchError) throw cause;
      throw new FrpFetchError(
        "download-failed",
        `The download from ${new URL(url).host} failed: ${cause instanceof Error ? cause.message : "unknown error"}.`,
      );
    }

    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new FrpFetchError(
        "checksum-mismatch",
        `The downloaded ${entry.file} does not match the pinned SHA-256 (got ${actual}); it was discarded.`,
      );
    }
    return bytes;
  };

  const cachePath =
    input.archiveCacheDir === undefined
      ? undefined
      : NodePath.join(input.archiveCacheDir, entry.file);
  const cachedBytes =
    cachePath === undefined ? undefined : await readPinnedArchive(cachePath, entry.sha256);
  const bytes = cachedBytes ?? (await download());
  if (cachePath !== undefined && cachedBytes === undefined) await storeArchive(cachePath, bytes);

  const workDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3x-frp-"));
  try {
    const archivePath = NodePath.join(workDir, entry.file);
    await NodeFSP.writeFile(archivePath, bytes, { mode: 0o600 });
    const unpacked = NodePath.join(workDir, "unpacked");
    await NodeFSP.mkdir(unpacked);
    // Only the one member we want is unpacked: nothing else in the archive is ever written to disk.
    // Archive member names use "/" on every platform. Windows ships bsdtar, which reads zip too; it is
    // named by path because a Git for Windows shell puts its GNU tar, which cannot, first on PATH.
    const member = `${frpArchiveDirectory(entry)}/${entry.executable}`;
    const tar =
      HostProcess.Platform.defaultValue() === "win32"
        ? NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
        : "tar";
    try {
      await execFile(tar, ["-xf", archivePath, "-C", unpacked, member], { windowsHide: true });
    } catch (cause) {
      throw new FrpFetchError(
        "extract-failed",
        `The archive could not be unpacked with tar: ${cause instanceof Error ? cause.message : "unknown error"}.`,
      );
    }
    const extracted = NodePath.join(unpacked, ...member.split("/"));
    const stat = await NodeFSP.lstat(extracted).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) {
      throw new FrpFetchError(
        "extract-failed",
        `The archive does not contain ${entry.executable}.`,
      );
    }
    // A directory made here is closed to everyone else's writes whatever the umask says; one that
    // was already there is not ours to change.
    const created = await NodeFSP.mkdir(input.destination, { recursive: true, mode: 0o755 });
    if (created !== undefined) await NodeFSP.chmod(input.destination, 0o755);
    const finalPath = NodePath.join(input.destination, entry.executable);
    const partial = `${finalPath}.${process.pid}.${NodeCrypto.randomBytes(8).toString("hex")}.partial`;
    try {
      await NodeFSP.copyFile(extracted, partial, NodeFS.constants.COPYFILE_EXCL);
      await NodeFSP.chmod(partial, 0o755);
      await NodeFSP.rename(partial, finalPath);
    } catch (cause) {
      await NodeFSP.rm(partial, { force: true });
      throw cause;
    }
    return { path: finalPath, url, sha256: entry.sha256, fromCache: cachedBytes !== undefined };
  } finally {
    await NodeFSP.rm(workDir, { recursive: true, force: true });
  }
};

export type FrpcVersionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not-runnable" | "wrong-version";
      readonly found: string;
    };

/** Runs `frpc -v`; the output must be exactly the pinned version. */
export const checkFrpcVersion = async (executable: string): Promise<FrpcVersionCheck> => {
  try {
    const { stdout } = await execFile(executable, ["-v"], {
      timeout: VERSION_CHECK_TIMEOUT_MS,
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    const found = stdout.trim();
    return found === FRP_VERSION
      ? { ok: true }
      : { ok: false, reason: "wrong-version", found: found.slice(0, 40) };
  } catch {
    return { ok: false, reason: "not-runnable", found: "" };
  }
};
