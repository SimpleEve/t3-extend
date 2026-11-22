// @effect-diagnostics nodeBuiltinImport:off processEnv:off - A dependency-free step of the release workflow.
// T3 Extend: an installed desktop app updates from `latest-mac.yml` / `latest.yml` in the release. They
// name the files to download by exact asset name and digest, so before anything is attached the release
// job checks that each name exists beside them with the digest and size the manifest claims.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export interface UpdateFeedFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

/** The `files:` entries electron-builder and renderMacUpdateManifest write; quotes are optional. */
export function readUpdateFeedFiles(manifest: string): ReadonlyArray<UpdateFeedFile> {
  const unquote = (value: string) => value.trim().replace(/^'(.*)'$/u, "$1");
  const files: Array<{ url?: string; sha512?: string; size?: number }> = [];
  for (const line of manifest.split(/\r?\n/u)) {
    const url = /^ {2}- url: (.+)$/u.exec(line);
    if (url) files.push({ url: unquote(url[1]!) });
    const sha512 = /^ {4}sha512: (.+)$/u.exec(line);
    if (sha512 && files.length > 0) files.at(-1)!.sha512 = unquote(sha512[1]!);
    const size = /^ {4}size: (\d+)$/u.exec(line);
    if (size && files.length > 0) files.at(-1)!.size = Number(size[1]);
  }
  return files.map((file) => {
    if (file.url === undefined || file.sha512 === undefined || file.size === undefined) {
      throw new Error(`Incomplete files entry in the update manifest: ${JSON.stringify(file)}.`);
    }
    return { url: file.url, sha512: file.sha512, size: file.size };
  });
}

/** What is wrong with the update manifests in `directory`; empty when every named file matches. */
export function checkUpdateFeeds(input: {
  readonly directory: string;
  readonly version: string;
  /** Manifests that must be present; an `.exe` they name also needs its `.blockmap`. */
  readonly manifests: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const problems: Array<string> = [];
  for (const manifestName of input.manifests) {
    const manifestPath = NodePath.join(input.directory, manifestName);
    if (!NodeFS.existsSync(manifestPath)) {
      problems.push(`${manifestName} is missing.`);
      continue;
    }
    const manifest = NodeFS.readFileSync(manifestPath, "utf8");
    if (
      !new RegExp(`^version: '?${input.version.replaceAll(".", "\\.")}'?$`, "mu").test(manifest)
    ) {
      problems.push(`${manifestName} does not say version ${input.version}.`);
    }
    const files = readUpdateFeedFiles(manifest);
    if (files.length === 0) problems.push(`${manifestName} lists no files.`);
    for (const file of files) {
      const filePath = NodePath.join(input.directory, file.url);
      if (!NodeFS.existsSync(filePath)) {
        problems.push(`${manifestName} names ${file.url}, which is not among the release assets.`);
        continue;
      }
      const bytes = NodeFS.readFileSync(filePath);
      if (bytes.length !== file.size) {
        problems.push(
          `${file.url}: ${manifestName} says ${file.size} bytes, the file has ${bytes.length}.`,
        );
      }
      if (NodeCrypto.createHash("sha512").update(bytes).digest("base64") !== file.sha512) {
        problems.push(`${file.url}: the sha512 in ${manifestName} does not match the file.`);
      }
      if (file.url.endsWith(".exe") && !NodeFS.existsSync(`${filePath}.blockmap`)) {
        problems.push(`${file.url}.blockmap is missing; differential updates need it.`);
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: { dir: { type: "string" }, version: { type: "string" } },
  });
  const problems = checkUpdateFeeds({
    directory: values.dir ?? "",
    version: values.version ?? "",
    manifests: ["latest-mac.yml", "latest.yml"],
  });
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`::error::${problem}\n`);
    process.exit(1);
  }
  process.stdout.write("Update manifests match the release assets.\n");
}
