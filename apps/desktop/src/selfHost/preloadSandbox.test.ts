// @effect-diagnostics nodeBuiltinImport:off -- Reads preload.ts as text; nothing runs through Effect here.
import * as NodeFS from "node:fs";

import { SELF_HOST_BRIDGE_GLOBAL as SHARED_SELF_HOST_BRIDGE_GLOBAL } from "@t3tools/shared/selfHost";
import { describe, expect, it } from "vite-plus/test";

import { KEEP_AWAKE_BRIDGE_GLOBAL as SHARED_KEEP_AWAKE_BRIDGE_GLOBAL } from "@t3tools/shared/keepAwake"; // fork: keep awake
import { KEEP_AWAKE_BRIDGE_GLOBAL } from "../keepAwake/keepAwakeChannels.ts"; // fork: keep awake
import { LOOPBACK_GATEWAY_BRIDGE_GLOBAL as SHARED_LOOPBACK_GATEWAY_BRIDGE_GLOBAL } from "@t3tools/shared/forkLoopbackGateway/bridge"; // fork: loopback gateway
import { LOOPBACK_GATEWAY_BRIDGE_GLOBAL } from "../fork/loopbackGateway/channels.ts"; // fork: loopback gateway
import { SELF_HOST_BRIDGE_GLOBAL } from "./selfHostChannels.ts";

// The sandboxed preload's `require` resolves only these; workspace packages fail at load time.
const SANDBOX_RUNTIME_IMPORTS = new Set(["electron", "@clerk/electron/preload"]);

const runtimeImportSources = (source: string): ReadonlyArray<string> =>
  Array.from(source.matchAll(/^import\s+(type\s+)?(?:[^;]*?\s+from\s+)?"([^"]+)"/gm))
    .filter((match) => match[1] === undefined)
    .map((match) => match[2]!);

describe("desktop preload sandbox", () => {
  it("imports runtime values only from relative modules and sandbox-resolvable packages", () => {
    const source = NodeFS.readFileSync(new URL("../preload.ts", import.meta.url), "utf8");
    const imports = runtimeImportSources(source);
    expect(imports).toContain("electron");
    expect(
      imports.filter((from) => !from.startsWith("./") && !SANDBOX_RUNTIME_IMPORTS.has(from)),
    ).toEqual([]);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it("exposes the bridge under the name the web client reads", () => {
    expect(SELF_HOST_BRIDGE_GLOBAL).toBe(SHARED_SELF_HOST_BRIDGE_GLOBAL);
    expect(KEEP_AWAKE_BRIDGE_GLOBAL).toBe(SHARED_KEEP_AWAKE_BRIDGE_GLOBAL); // fork: keep awake
    expect(LOOPBACK_GATEWAY_BRIDGE_GLOBAL).toBe(SHARED_LOOPBACK_GATEWAY_BRIDGE_GLOBAL); // fork: loopback gateway
  });
});
