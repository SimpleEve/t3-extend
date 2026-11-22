// @effect-diagnostics nodeBuiltinImport:off - Fixtures on disk for a dependency-free release step.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { checkUpdateFeeds, readUpdateFeedFiles } from "./fork-check-update-feeds.ts";

const VERSION = "0.1.11-1.7";
const digest = (content: string) =>
  NodeCrypto.createHash("sha512").update(content).digest("base64");

const withAssets = (
  assets: Readonly<Record<string, string>>,
  run: (directory: string) => void,
): void => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-feeds-"));
  try {
    for (const [name, content] of Object.entries(assets)) {
      NodeFS.writeFileSync(NodePath.join(directory, name), content);
    }
    run(directory);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

const manifest = (url: string, content: string, quoted: boolean) => {
  const q = quoted ? "'" : "";
  return [
    `version: ${q}${VERSION}${q}`,
    "files:",
    `  - url: ${url}`,
    `    sha512: ${q}${digest(content)}${q}`,
    `    size: ${content.length}`,
    `path: ${url}`,
    "",
  ].join("\n");
};

const GOOD = {
  "T3-Extend-0.1.11-1.7-arm64.zip": "zip",
  "latest-mac.yml": manifest("T3-Extend-0.1.11-1.7-arm64.zip", "zip", true),
  "T3-Extend-0.1.11-1.7-x64.exe": "exe",
  "T3-Extend-0.1.11-1.7-x64.exe.blockmap": "map",
  "latest.yml": manifest("T3-Extend-0.1.11-1.7-x64.exe", "exe", false),
};
const check = (directory: string) =>
  checkUpdateFeeds({ directory, version: VERSION, manifests: ["latest-mac.yml", "latest.yml"] });

it("reads both manifest styles", () => {
  expect(readUpdateFeedFiles(GOOD["latest-mac.yml"])).toEqual([
    { url: "T3-Extend-0.1.11-1.7-arm64.zip", sha512: digest("zip"), size: 3 },
  ]);
  expect(readUpdateFeedFiles(GOOD["latest.yml"])[0]?.url).toBe("T3-Extend-0.1.11-1.7-x64.exe");
});

it("accepts manifests that match the assets", () => {
  withAssets(GOOD, (directory) => expect(check(directory)).toEqual([]));
});

it.each([
  ["a manifest is missing", { ...GOOD, "latest.yml": undefined }, /latest\.yml is missing/u],
  [
    "a named file was renamed",
    { ...GOOD, "T3-Extend-0.1.11-1.7-arm64.zip": undefined },
    /not among the release assets/u,
  ],
  [
    "the bytes differ",
    { ...GOOD, "T3-Extend-0.1.11-1.7-x64.exe": "EXE" },
    /sha512 .* does not match/u,
  ],
  [
    "the blockmap is missing",
    { ...GOOD, "T3-Extend-0.1.11-1.7-x64.exe.blockmap": undefined },
    /blockmap is missing/u,
  ],
])("reports when %s", (_case, assets, expected) => {
  const present = Object.fromEntries(
    Object.entries(assets).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  withAssets(present, (directory) => expect(check(directory).join("\n")).toMatch(expected));
});
