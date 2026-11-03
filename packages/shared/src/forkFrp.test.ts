// @effect-diagnostics nodeBuiltinImport:off -- Reads the compose file the pin must agree with.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  FRP_ARCHIVES,
  FRP_RELEASE_BASE_URL,
  FRP_VERSION,
  FRPS_IMAGE_TAG,
  frpArchiveDirectory,
  frpArchiveFor,
  frpArchiveUrl,
} from "./forkFrp.ts";

const COMPOSE = NodePath.resolve(
  import.meta.dirname,
  "../../../infra/self-host/docker-compose.yml",
);

describe("forkFrp", () => {
  it("pins the same frp release in the compose file's frps image", () => {
    const image = /image:\s*fatedier\/frps:(v[\w.]+)@sha256:[0-9a-f]{64}/.exec(
      NodeFS.readFileSync(COMPOSE, "utf8"),
    );
    expect(image?.[1]).toBe(FRPS_IMAGE_TAG);
    expect(FRPS_IMAGE_TAG).toBe(`v${FRP_VERSION}`);
  });

  it("covers every platform the app ships on, each with a SHA-256", () => {
    expect(Object.keys(FRP_ARCHIVES).toSorted()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    for (const entry of Object.values(FRP_ARCHIVES)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.file).toMatch(new RegExp(`^frp_${FRP_VERSION}_`));
    }
  });

  it("maps Node's platform and arch to an archive, and nothing for the rest", () => {
    expect(frpArchiveFor("darwin", "arm64")?.file).toBe(`frp_${FRP_VERSION}_darwin_arm64.tar.gz`);
    expect(frpArchiveFor("win32", "x64")?.executable).toBe("frpc.exe");
    expect(frpArchiveFor("freebsd", "x64")).toBeUndefined();
    expect(frpArchiveFor("linux", "toString")).toBeUndefined();
  });

  it("builds the download URL from the release or from a mirror, and names the extracted directory", () => {
    const entry = FRP_ARCHIVES["linux-arm64"];
    expect(frpArchiveUrl(entry)).toBe(`${FRP_RELEASE_BASE_URL}/${entry.file}`);
    expect(frpArchiveUrl(entry, "https://mirror.example/frp//")).toBe(
      `https://mirror.example/frp/${entry.file}`,
    );
    expect(frpArchiveDirectory(entry)).toBe(`frp_${FRP_VERSION}_linux_arm64`);
    expect(frpArchiveDirectory(FRP_ARCHIVES["win32-x64"])).toBe(`frp_${FRP_VERSION}_windows_amd64`);
  });
});
