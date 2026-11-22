// @effect-diagnostics nodeBuiltinImport:off - build tooling that hashes a file on disk.
// T3 Extend: fork-dist-mac.ts signs the .app itself and never runs electron-builder's zip target, so
// the zip Squirrel.Mac installs from and the `latest-mac.yml` that names it are written here, in the
// shape electron-builder would have produced.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { serializeUpdateManifest } from "./update-manifest.ts";

/** electron-updater verifies the download against the base64 SHA-512 of the exact bytes uploaded. */
export function renderMacUpdateManifest(input: {
  readonly version: string;
  readonly zipPath: string;
  /** The uploaded name; electron-updater resolves it next to the manifest in the release. */
  readonly zipName: string;
  readonly releaseDate: Date;
}): string {
  const bytes = NodeFS.readFileSync(input.zipPath);
  const sha512 = NodeCrypto.createHash("sha512").update(bytes).digest("base64");
  return serializeUpdateManifest(
    {
      version: input.version,
      releaseDate: input.releaseDate.toISOString(),
      files: [{ url: input.zipName, sha512, size: bytes.length }],
      extras: { path: input.zipName, sha512 },
    },
    { platformLabel: "macOS" },
  );
}
