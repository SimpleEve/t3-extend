import { cliReleaseChannelOf, newestCliReleaseVersion } from "@t3tools/shared/cliRelease";
import { isExactServiceVersion } from "../apps/server/src/cloud/serviceProtocol.ts";
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

it("publishes a plain vX.Y.Z tag that is newer than every published one", () => {
  expect(tagPush("v0.2.0", ["v0.1.10", "v0.1.9"])).toEqual({
    version: "0.2.0",
    tag: "v0.2.0",
    publish: true,
  });
  // Numeric, not lexicographic: 0.1.9 < 0.1.10.
  expect(tagPush("v0.1.10", ["v0.1.9"]).publish).toBe(true);
});

it("refuses a tag that t3x update would not offer as the newest", () => {
  expect(() => tagPush("v0.1.9", ["v0.1.10"])).toThrow(/not newer/u);
  expect(() => tagPush("v0.1.10", ["v0.1.10"])).toThrow(/not newer/u);
  // Another channel, or not a version at all.
  expect(() => tagPush("v0.2.0-nightly.20261118.1")).toThrow(/vX\.Y\.Z/u);
  expect(() => tagPush("v0.2.0-preview.20261118.1")).toThrow(/vX\.Y\.Z/u);
  expect(() => tagPush("v1.2")).toThrow(/vX\.Y\.Z/u);
  expect(() => tagPush("release-1")).toThrow(/not a version tag/u);
});

it("keeps test builds out of updates, from a tag or a manual run", () => {
  expect(tagPush("v0.0.0-ci.3", ["v9.9.9"])).toEqual({
    version: "0.0.0-ci.3",
    tag: "v0.0.0-ci.3",
    publish: false,
  });
  const dispatch = (dispatchVersion: string) =>
    resolveForkRelease({
      eventName: "workflow_dispatch",
      ref: "refs/heads/some-branch",
      dispatchVersion,
      runNumber: "12",
      publishedTags: [],
    });
  expect(dispatch("")).toEqual({ version: "0.0.0-ci.12", tag: "v0.0.0-ci.12", publish: false });
  expect(dispatch("0.3.1-ci.2").tag).toBe("v0.3.1-ci.2");
  // A branch run can never publish a real version.
  expect(() => dispatch("0.3.1")).toThrow(/test release/u);
});

it("only produces versions the self-update path accepts", () => {
  for (const version of ["0.2.0", "0.0.0-ci.3"]) {
    expect(isExactServiceVersion(version)).toBe(true);
    expect(cliReleaseChannelOf(version)).toBe("stable");
  }
  // The newest published release is a plain tag; a draft test build is skipped even though it
  // reads as stable.
  expect(
    newestCliReleaseVersion(
      [{ tag_name: "v0.0.0-ci.3", draft: true }, { tag_name: "v0.2.0" }, { tag_name: "v0.1.10" }],
      "stable",
    ),
  ).toBe("0.2.0");
});
