// @effect-diagnostics nodeBuiltinImport:off - build tooling around the shared pinned download.
// T3 Extend: the pinned frpc for this machine, for the packaging script and the end-to-end script.
// A download goes through the shared code (SHA-256 checked) into `release/fork-cache/`, which is
// gitignored and belongs to this fork alone; a later run reuses it after `frpc -v` and a digest
// check. `--frpc-path` skips the download for offline use, with the same `frpc -v` check.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { FRP_MIRROR_ENV, FRP_VERSION } from "@t3tools/shared/forkFrp";
import { checkFrpcVersion, fetchFrpc } from "@t3tools/shared/forkFrpFetch";
import * as HostProcess from "@t3tools/shared/HostProcess";

const repoRoot = NodePath.resolve(import.meta.dirname, "../..");

const sha256OfFile = (filePath: string): string =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");

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
 * A runnable frpc at exactly the pinned version: `explicitPath` when given, else the cached download
 * (fetched first if missing or if the cached file no longer matches the digest recorded for it).
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
    options.log(`frpc ${FRP_VERSION}: ${explicit} (--frpc-path)`);
    return explicit;
  }

  const directory = frpcCacheDirectory();
  const cached = NodePath.join(directory, "frpc");
  const digestFile = `${cached}.sha256`;
  if (NodeFS.existsSync(cached) && NodeFS.existsSync(digestFile)) {
    const recorded = NodeFS.readFileSync(digestFile, "utf8").trim();
    if (recorded === sha256OfFile(cached) && (await checkFrpcVersion(cached)).ok) {
      options.log(`frpc ${FRP_VERSION}: ${cached} (cached)`);
      return cached;
    }
    options.log(
      `The cached frpc at ${cached} does not match its digest or version; fetching again.`,
    );
  }
  const fetched = await fetchFrpc({
    platform: HostProcess.Platform.defaultValue(),
    arch: HostProcess.Architecture.defaultValue(),
    destination: directory,
    baseUrl: options.baseUrl ?? process.env[FRP_MIRROR_ENV],
  });
  await requireVersion(fetched.path);
  NodeFS.writeFileSync(digestFile, `${sha256OfFile(fetched.path)}\n`);
  options.log(`frpc ${FRP_VERSION}: ${fetched.path} (downloaded from ${fetched.url})`);
  return fetched.path;
}
