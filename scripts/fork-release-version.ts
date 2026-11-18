// @effect-diagnostics nodeBuiltinImport:off processEnv:off - A dependency-free step of the release workflow: it runs before any install.
// T3 Extend: decide what fork-release.yml publishes. See FORK.md "打包与签名".
//
// Why only `vX.Y.Z`: `t3x update` lists `releases?per_page=100`, skips drafts, and takes the FIRST
// tag matching `v<semver>` whose channel is its own (`cliReleaseChannelOf`, `newestCliReleaseVersion`
// in packages/shared/src/cliRelease.ts). Anything with a `-nightly.` or `-preview.` suffix is another
// channel, which an update refuses to cross, and the list is ordered by creation, not by version. So
// a published tag must be plain `X.Y.Z` and greater than every published tag, or a stale build
// created later would be offered as the newest.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

export interface ForkRelease {
  readonly version: string;
  readonly tag: string;
  /** Published to `t3x update` once every asset is attached. Test builds stay drafts forever. */
  readonly publish: boolean;
}

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
// `-ci.N` is not a channel suffix, so it reads as stable; only the draft flag keeps it out of updates.
const TEST_BUILD = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-ci\.\d+$/u;

const triple = (version: string): ReadonlyArray<number> =>
  version.split("-")[0]!.split(".").map(Number);

function compareStable(left: string, right: string): number {
  const a = triple(left);
  const b = triple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
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
  if (input.eventName === "workflow_dispatch") {
    const version = input.dispatchVersion.trim() || `0.0.0-ci.${input.runNumber}`;
    if (!TEST_BUILD.test(version)) {
      throw new Error(
        `A manual run builds a test release: its version must look like 1.2.3-ci.4, not '${version}'. Publish by pushing a vX.Y.Z tag.`,
      );
    }
    return { version, tag: `v${version}`, publish: false };
  }
  const tag = input.ref.replace(/^refs\/tags\//u, "");
  const version = tag.replace(/^v/u, "");
  if (!tag.startsWith("v")) throw new Error(`'${tag}' is not a version tag (vX.Y.Z).`);
  if (TEST_BUILD.test(version)) return { version, tag, publish: false };
  if (!STABLE.test(version)) {
    throw new Error(
      `Tag '${tag}' must be vX.Y.Z (or vX.Y.Z-ci.N for a test build): t3x update ignores any other suffix, and a nightly or preview suffix is a different channel.`,
    );
  }
  const newer = input.publishedTags
    .map((published) => published.replace(/^v/u, ""))
    .filter((published) => STABLE.test(published) && compareStable(published, version) >= 0);
  if (newer.length > 0) {
    throw new Error(
      `v${version} is not newer than the published ${newer.map((v) => `v${v}`).join(", ")}. t3x update takes the most recently created release, so versions must only go up.`,
    );
  }
  return { version, tag, publish: true };
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
  const lines = `version=${release.version}\ntag=${release.tag}\npublish=${String(release.publish)}\n`;
  process.stdout.write(lines);
  if (process.env.GITHUB_OUTPUT) NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, lines);
}
