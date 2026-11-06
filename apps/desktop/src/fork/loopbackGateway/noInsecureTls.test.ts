// @effect-diagnostics nodeBuiltinImport:off -- Reads this repository's sources as text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

// research/remote-loopback-forwarding.md 3.6: certificate validation is never weakened, anywhere,
// and the main process does not read the system trust store.
const REPOSITORY = NodeURL.fileURLToPath(new URL("../../../../../", import.meta.url));
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;

const sourceFiles = (directory: string): Array<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      return [];
    }
    const full = NodePath.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : SOURCE_FILE.test(entry.name) ? [full] : [];
  });

const sourceRoots = (): Array<string> =>
  ["apps", "packages"].flatMap((group) =>
    NodeFS.readdirSync(NodePath.join(REPOSITORY, group), { withFileTypes: true }).flatMap(
      (entry) => {
        const src = NodePath.join(REPOSITORY, group, entry.name, "src");
        return entry.isDirectory() && NodeFS.existsSync(src) ? [src] : [];
      },
    ),
  );

const self = NodeURL.fileURLToPath(import.meta.url);

const offenders = (roots: ReadonlyArray<string>, pattern: RegExp): Array<string> =>
  roots
    .flatMap(sourceFiles)
    .filter((file) => file !== self)
    .filter((file) => pattern.test(NodeFS.readFileSync(file, "utf8")))
    .map((file) => NodePath.relative(REPOSITORY, file));

describe("TLS validation", () => {
  it("is never switched off in any source file of the apps or packages", () => {
    expect(offenders(sourceRoots(), /rejectUnauthorized\s*:\s*(?:false|0|!1)\b/u)).toEqual([]);
    expect(offenders(sourceRoots(), /NODE_TLS_REJECT_UNAUTHORIZED/u)).toEqual([]);
    expect(offenders(sourceRoots(), /\bcheckServerIdentity\b/u)).toEqual([]);
  });

  it("does not reach into the system trust store from the desktop main process", () => {
    const desktop = [NodePath.join(REPOSITORY, "apps", "desktop", "src")];
    const production = (file: string) => !/\.(?:test|testkit)\.[cm]?[jt]sx?$/u.test(file);
    const found = desktop
      .flatMap(sourceFiles)
      .filter(production)
      .filter((file) =>
        /setDefaultCACertificates|getCACertificates|--use-system-ca|useSystemCa/u.test(
          NodeFS.readFileSync(file, "utf8"),
        ),
      );
    expect(found).toEqual([]);
  });

  it("finds a violation when there is one", () => {
    const sample = "const options = { rejectUnauthorized: false };";
    expect(/rejectUnauthorized\s*:\s*(?:false|0|!1)\b/u.test(sample)).toBe(true);
  });
});
