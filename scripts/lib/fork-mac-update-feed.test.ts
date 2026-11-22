// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Fixtures on disk for a build-tooling helper.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { renderAppUpdateConfig, renderMacUpdateManifest } from "./fork-mac-update-feed.ts";
import { parseUpdateManifest } from "./update-manifest.ts";

describe("renderMacUpdateManifest", () => {
  it("names the uploaded zip with the digest and size of its bytes", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-mac-feed-"));
    try {
      const zipPath = NodePath.join(directory, "local-name.zip");
      NodeFS.writeFileSync(zipPath, "zip bytes");
      const rendered = renderMacUpdateManifest({
        version: "0.1.11-1.7",
        zipPath,
        zipName: "T3-Extend-0.1.11-1.7-arm64.zip",
        releaseDate: new Date("2026-11-22T00:00:00.000Z"),
      });
      const sha512 = NodeCrypto.createHash("sha512").update("zip bytes").digest("base64");
      const parsed = parseUpdateManifest(rendered, "latest-mac.yml", "macOS");
      expect(parsed.version).toBe("0.1.11-1.7");
      expect(parsed.files).toEqual([{ url: "T3-Extend-0.1.11-1.7-arm64.zip", sha512, size: 9 }]);
      // The parser derives these two from `files`; electron-updater reads them from the top level.
      expect(rendered).toContain("\npath: 'T3-Extend-0.1.11-1.7-arm64.zip'\n");
      expect(rendered).toContain(`\nsha512: '${sha512}'\n`);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("renderAppUpdateConfig", () => {
  it("points the app at the GitHub repository with its own cache directory", () => {
    expect(
      renderAppUpdateConfig({ repository: "SimpleEve/t3-extend", packageName: "t3extend" }),
    ).toBe(
      "owner: SimpleEve\nrepo: t3-extend\nprovider: github\nreleaseType: release\nupdaterCacheDirName: t3extend-updater\n",
    );
  });

  it.each(["", "SimpleEve", "a/b/c", "owner/re po"])("rejects the repository %j", (repository) => {
    expect(() => renderAppUpdateConfig({ repository, packageName: "t3extend" })).toThrow(
      /owner\/repo/u,
    );
  });
});
