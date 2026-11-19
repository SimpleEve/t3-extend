// @effect-diagnostics nodeBuiltinImport:off processEnv:off - A dependency-free step of the release workflow: it runs before any install.
// T3 Extend: decide what fork-release.yml publishes. See FORK.md "打包与签名".
//
// Versions: `<upstream>-<fork>`, like `0.1.11-1.0`. The first half is the upstream release the
// fork last merged, the second is the fork's own `major.minor`, which keeps counting up across
// upstream syncs. `t3x update` lists `releases?per_page=100`, skips drafts, and takes the FIRST tag
// whose channel is its own (`cliReleaseChannelOf`, `newestCliReleaseVersion` in
// packages/shared/src/cliRelease.ts); `-1.0` reads as stable, while `-nightly.` and `-preview.` are
// other channels. The list is ordered by creation, not by version, so a published tag must be
// greater than every published tag under semver, or a stale build created later would be offered
// as the newest. Under semver `0.1.10-9.0` < `0.1.10`, so the upstream half must also move past
// a plain `X.Y.Z` that is already out.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

export interface ForkRelease {
  readonly version: string;
  readonly tag: string;
  /** Published to `t3x update` once every asset is attached. Test builds stay drafts forever. */
  readonly publish: boolean;
  /** The fork's own `major.minor`; empty for a test build. */
  readonly fork: string;
  /** Android versionCode: fork major * 1000 + minor, so it only rises. Empty for a test build. */
  readonly androidVersionCode: string;
}

const CORE = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`;
const FORK_RELEASE = new RegExp(`^${CORE}-(0|[1-9]\\d*)\\.(0|[1-9]\\d{0,2})$`, "u");
// `-ci.N` is not a channel suffix, so it reads as stable; only the draft flag keeps it out of updates.
const TEST_BUILD = new RegExp(`^${CORE}-ci\\.\\d+$`, "u");
const PLAIN = new RegExp(`^${CORE}$`, "u");

/** Semver order for `X.Y.Z` and `X.Y.Z-A.B`, numeric throughout; a plain version outranks its suffixes. */
export function compareReleaseVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const [core = "", suffix] = version.split("-", 2);
    return { core: core.split(".").map(Number), suffix: suffix?.split(".").map(Number) };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (a.suffix === undefined || b.suffix === undefined) {
    return a.suffix === b.suffix ? 0 : a.suffix === undefined ? 1 : -1;
  }
  for (let index = 0; index < 2; index += 1) {
    if (a.suffix[index] !== b.suffix[index]) return a.suffix[index]! < b.suffix[index]! ? -1 : 1;
  }
  return 0;
}

export function resolveForkRelease(input: {
  readonly eventName: string;
  readonly ref: string;
  /** workflow_dispatch input; empty means the default test version. */
  readonly dispatchVersion: string;
  readonly runNumber: string;
  /** Tags of every non-draft release, with or without the leading `v`. */
  readonly publishedTags: ReadonlyArray<string>;
}): ForkRelease {
  const testBuild = (version: string, tag: string): ForkRelease => ({
    version,
    tag,
    publish: false,
    fork: "",
    androidVersionCode: "",
  });
  if (input.eventName === "workflow_dispatch") {
    const version = input.dispatchVersion.trim() || `0.0.0-ci.${input.runNumber}`;
    if (!TEST_BUILD.test(version)) {
      throw new Error(
        `A manual run builds a test release: its version must look like 1.2.3-ci.4, not '${version}'. Publish by pushing a vX.Y.Z-A.B tag.`,
      );
    }
    return testBuild(version, `v${version}`);
  }
  const tag = input.ref.replace(/^refs\/tags\//u, "");
  const version = tag.replace(/^v/u, "");
  if (!tag.startsWith("v")) throw new Error(`'${tag}' is not a version tag (vX.Y.Z-A.B).`);
  if (TEST_BUILD.test(version)) return testBuild(version, tag);
  const match = FORK_RELEASE.exec(version);
  if (match === null) {
    throw new Error(
      `Tag '${tag}' must be v<upstream X.Y.Z>-<fork A.B>, like v0.1.11-1.0 (or vX.Y.Z-ci.N for a test build): t3x update ignores any other suffix, and a nightly or preview suffix is a different channel.`,
    );
  }
  const newer = input.publishedTags
    .map((published) => published.replace(/^v/u, ""))
    .filter((published) => FORK_RELEASE.test(published) || PLAIN.test(published))
    .filter((published) => compareReleaseVersions(published, version) >= 0);
  if (newer.length > 0) {
    throw new Error(
      `v${version} is not newer than the published ${newer.map((v) => `v${v}`).join(", ")}. t3x update takes the most recently created release, so versions must only go up.`,
    );
  }
  const forkMajor = Number(match[4]);
  const forkMinor = Number(match[5]);
  return {
    version,
    tag,
    publish: true,
    fork: `${forkMajor}.${forkMinor}`,
    androidVersionCode: String(forkMajor * 1000 + forkMinor),
  };
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      "event-name": { type: "string" },
      ref: { type: "string" },
      "dispatch-version": { type: "string", default: "" },
      "run-number": { type: "string" },
    },
  });
  const release = resolveForkRelease({
    eventName: values["event-name"] ?? "",
    ref: values.ref ?? "",
    dispatchVersion: values["dispatch-version"] ?? "",
    runNumber: values["run-number"] ?? "0",
    publishedTags: (process.env.PUBLISHED_TAGS ?? "").split(/\s+/u).filter(Boolean),
  });
  const lines = [
    `version=${release.version}`,
    `tag=${release.tag}`,
    `publish=${String(release.publish)}`,
    `fork=${release.fork}`,
    `android_version_code=${release.androidVersionCode}`,
    "",
  ].join("\n");
  process.stdout.write(lines);
  if (process.env.GITHUB_OUTPUT) NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, lines);
}
