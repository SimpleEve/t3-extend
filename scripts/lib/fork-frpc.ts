// @effect-diagnostics nodeBuiltinImport:off - build tooling around the shared pinned download.
// T3 Extend: the pinned frpc for this machine, for the packaging script and the end-to-end script.
// The release archive is cached in `release/fork-cache/` (gitignored, this fork's alone) and used only
// if its bytes hash to the SHA-256 pinned in forkFrp.ts at that moment; frpc is unpacked from it anew on
// every run. Nothing the cache says about itself is trusted. `--frpc-path` is for offline use: it is only
// checked with `frpc -v`, so what it points at is the caller's responsibility.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { FRP_MIRROR_ENV, FRP_VERSION } from "@t3tools/shared/forkFrp";
import { checkFrpcVersion, fetchFrpc } from "@t3tools/shared/forkFrpFetch";
import * as HostProcess from "@t3tools/shared/HostProcess";

const repoRoot = NodePath.resolve(import.meta.dirname, "../..");

async function requireVersion(filePath: string): Promise<void> {
  const check = await checkFrpcVersion(filePath);
  if (!check.ok) {
    throw new Error(
      `${filePath}: frpc -v did not report ${FRP_VERSION} (${check.reason}${check.found === "" ? "" : `: ${check.found}`}).`,
    );
  }
}

/** Where a downloaded frpc is kept between runs. */
export const frpcCacheDirectory = (
  platform = HostProcess.Platform.defaultValue(),
  arch = HostProcess.Architecture.defaultValue(),
): string =>
  NodePath.join(repoRoot, "release/fork-cache/frp", `v${FRP_VERSION}`, `${platform}-${arch}`);

/**
 * A runnable frpc at exactly the pinned version: `explicitPath` when given, else one unpacked from the
 * archive that matched the pinned digest (downloaded now if the cache has no such archive).
 */
export async function resolveFrpc(options: {
  readonly explicitPath?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly log: (message: string) => void;
}): Promise<string> {
  if (options.explicitPath !== undefined) {
    const explicit = NodePath.resolve(options.explicitPath);
    if (!NodeFS.statSync(explicit, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`--frpc-path ${explicit} is not a file.`);
    }
    await requireVersion(explicit);
    options.log(
      `frpc ${FRP_VERSION}: ${explicit} (--frpc-path: supplied by you, not checked against the pinned SHA-256)`,
    );
    return explicit;
  }

  const directory = frpcCacheDirectory();
  // Files an earlier version of this script left next to the archive: an unpacked frpc and a digest it
  // wrote for itself. Neither is used any more.
  for (const stale of ["frpc", "frpc.sha256"]) {
    NodeFS.rmSync(NodePath.join(directory, stale), { force: true });
  }
  const fetched = await fetchFrpc({
    platform: HostProcess.Platform.defaultValue(),
    arch: HostProcess.Architecture.defaultValue(),
    destination: NodePath.join(directory, "unpacked"),
    archiveCacheDir: directory,
    baseUrl: options.baseUrl ?? process.env[FRP_MIRROR_ENV],
  });
  await requireVersion(fetched.path);
  options.log(
    `frpc ${FRP_VERSION}: ${fetched.path} (unpacked from ${fetched.fromCache ? "the cached archive, which matches the pinned SHA-256" : `${fetched.url}, SHA-256 checked`})`,
  );
  return fetched.path;
}
