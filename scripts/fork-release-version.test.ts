import { cliReleaseChannelOf, newestCliReleaseVersion } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { expect, it } from "vite-plus/test";

import { resolveForkRelease } from "./fork-release-version.ts";

const tagPush = (tag: string, publishedTags: ReadonlyArray<string> = []) =>
  resolveForkRelease({
    eventName: "push",
    ref: `refs/tags/${tag}`,
    dispatchVersion: "",
    runNumber: "7",
    publishedTags,
  });

it("publishes an upstream-plus-fork tag that is newer than every published one", () => {
  expect(tagPush("v0.1.11-1.0", ["v0.1.10", "v0.0.0-ci.3"])).toEqual({
    version: "0.1.11-1.0",
    tag: "v0.1.11-1.0",
    publish: true,
    fork: "1.0",
    androidVersionCode: "1000",
  });
  // Numeric, not lexicographic, in both halves.
  expect(tagPush("v0.1.11-1.10", ["v0.1.11-1.9"]).publish).toBe(true);
  expect(tagPush("v0.1.12-1.11", ["v0.1.11-1.10"]).androidVersionCode).toBe("1011");
});

it("refuses a tag that t3x update would not offer as the newest", () => {
  expect(() => tagPush("v0.1.11-1.0", ["v0.1.11-1.0"])).toThrow(/not newer/u);
  expect(() => tagPush("v0.1.11-1.9", ["v0.1.11-1.10"])).toThrow(/not newer/u);
  // Semver puts a suffix below its plain version, so the upstream half must move past it.
  expect(() => tagPush("v0.1.10-2.0", ["v0.1.10"])).toThrow(/not newer/u);
  // The old plain form, another channel, or not a version at all.
  expect(() => tagPush("v0.2.0")).toThrow(/v0\.1\.11-1\.0/u);
  expect(() => tagPush("v0.2.0-nightly.20261118.1")).toThrow(/v0\.1\.11-1\.0/u);
  expect(() => tagPush("v0.2.0-1.1000")).toThrow(/v0\.1\.11-1\.0/u);
  expect(() => tagPush("release-1")).toThrow(/not a version tag/u);
});

it("keeps test builds out of updates, from a tag or a manual run", () => {
  expect(tagPush("v0.0.0-ci.3", ["v9.9.9-1.0"])).toEqual({
    version: "0.0.0-ci.3",
    tag: "v0.0.0-ci.3",
    publish: false,
    fork: "",
    androidVersionCode: "",
  });
  const dispatch = (dispatchVersion: string) =>
    resolveForkRelease({
      eventName: "workflow_dispatch",
      ref: "refs/heads/some-branch",
      dispatchVersion,
      runNumber: "12",
      publishedTags: [],
    });
  expect(dispatch("").tag).toBe("v0.0.0-ci.12");
  expect(dispatch("0.3.1-ci.2").tag).toBe("v0.3.1-ci.2");
  // A branch run can never publish a real version.
  expect(() => dispatch("0.3.1")).toThrow(/test release/u);
});

it("only produces versions on the channel the self-update path follows", () => {
  for (const version of ["0.1.11-1.0", "0.0.0-ci.3"]) {
    expect(cliReleaseChannelOf(version)).toBe("stable");
  }
  // The newest published release is a plain tag; a draft test build is skipped even though it
  // reads as stable.
  expect(
    newestCliReleaseVersion(
      [
        { tag_name: "v0.0.0-ci.3", draft: true },
        { tag_name: "v0.1.11-1.0" },
        { tag_name: "v0.1.10" },
      ],
      "stable",
    ),
  ).toBe("0.1.11-1.0");
  // The installed app, the server's self-update and the phone's update hint all agree on order.
  expect(compareSemverVersions("0.1.11-1.0", "0.1.10")).toBeGreaterThan(0);
  expect(compareSemverVersions("0.1.11-1.10", "0.1.11-1.9")).toBeGreaterThan(0);
  expect(compareSemverVersions("0.1.12-1.0", "0.1.11-1.99")).toBeGreaterThan(0);
});
