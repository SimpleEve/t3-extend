// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

const here = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const clientRuntimeSrc = NodePath.join(here, "..", "..");
const appsRoot = NodePath.join(clientRuntimeSrc, "..", "..", "..", "apps");

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

const RELAY_AUTHORIZATION = /\.(authorizeDpop|authorizeDpopHttp|renewDpopBeforeExpiry)\b/;

// A new caller of the relay's authorization has to be added here on purpose: it must either stay
// away from a stamped device connection or go through the same stamp the ones below check.
// connectMcpApproval builds its own unstamped `prepared` from the T3 Connect account's relay grant,
// so it can never carry the device marker.
describe("who may use the relay's DPoP authorization", () => {
  it("is exactly the resolver, the driver, the T3 Connect approval call and the HTTP authorization step", () => {
    const users = sourceFiles(clientRuntimeSrc)
      .filter((path) => RELAY_AUTHORIZATION.test(NodeFS.readFileSync(path, "utf8")))
      .map((path) => NodePath.relative(clientRuntimeSrc, path))
      // The service that defines them.
      .filter((path) => path !== NodePath.join("authorization", "service.ts"))
      .toSorted();
    expect(users).toEqual([
      NodePath.join("connection", "driver.ts"),
      NodePath.join("connection", "resolver.ts"),
      NodePath.join("state", "connectMcpApproval.ts"),
      NodePath.join("state", "environmentHttpAuth.ts"),
    ]);
  });

  it("is not reached from the web or mobile apps", () => {
    const users = [NodePath.join(appsRoot, "web", "src"), NodePath.join(appsRoot, "mobile", "src")]
      .flatMap(sourceFiles)
      .filter((path) => RELAY_AUTHORIZATION.test(NodeFS.readFileSync(path, "utf8")));
    expect(users).toEqual([]);
  });

  it("is never called by the files that only hand a connection to the HTTP step", () => {
    const callers = [
      "session",
      "peerPairingCode",
      "boundedThreadSnapshotHttp",
      "pullRequestDiffHttp",
      "deviceHubAccess",
      "shellSnapshotHttp",
      "threadHistoryHttp",
      "threadTranscriptHttp",
      "threads",
      "orchestration",
    ];
    for (const name of callers) {
      const source = NodeFS.readFileSync(
        NodePath.join(clientRuntimeSrc, "state", `${name}.ts`),
        "utf8",
      );
      expect(source, name).not.toMatch(RELAY_AUTHORIZATION);
    }
  });

  it("stamps the device marker in one place only", () => {
    const stampers = sourceFiles(clientRuntimeSrc)
      .filter((path) => /authorizer:\s*"t3x-device"/.test(NodeFS.readFileSync(path, "utf8")))
      .map((path) => NodePath.relative(clientRuntimeSrc, path));
    expect(stampers).toEqual([NodePath.join("connection", "resolver.ts")]);
  });
});
