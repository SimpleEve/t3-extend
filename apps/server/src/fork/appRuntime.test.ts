import { describe, expect, it } from "vite-plus/test";

import { detectAppRuntime } from "./appRuntime.ts";

const APP = "/Applications/T3 Extend.app";
const ENTRY = `${APP}/Contents/Resources/app.asar/apps/server/dist/bin.mjs`;
const EXECUTABLE = `${APP}/Contents/MacOS/T3 Extend`;
const shimEnvironment = {
  ELECTRON_RUN_AS_NODE: "1",
  T3X_FRPC_PATH: `${APP}/Contents/Resources/bin/frpc`,
};

const detect = (overrides: Partial<Parameters<typeof detectAppRuntime>[0]> = {}) =>
  detectAppRuntime({
    platform: "darwin",
    execPath: EXECUTABLE,
    argv: [EXECUTABLE, ENTRY, "service", "install"],
    env: shimEnvironment,
    ...overrides,
  });

describe("detectAppRuntime", () => {
  it("recognises the packaged macOS app's own CLI, the way the t3x shim starts it", () => {
    expect(detect()).toEqual({
      appPath: APP,
      executable: EXECUTABLE,
      entry: ENTRY,
      frpc: `${APP}/Contents/Resources/bin/frpc`,
    });
  });

  it("falls back to the frpc inside the app when the shim did not export one", () => {
    expect(detect({ env: { ELECTRON_RUN_AS_NODE: "1" } })?.frpc).toBe(
      `${APP}/Contents/Resources/bin/frpc`,
    );
  });

  it.each([
    [
      "an npm or pinned runtime install",
      { env: {}, execPath: "/usr/local/bin/node", argv: ["/usr/local/bin/node", "/x/t3/bin.mjs"] },
    ],
    ["a CLI that is not run as Node", { env: {} }],
    ["another platform", { platform: "linux" as const }],
    ["an entry outside the app", { argv: [EXECUTABLE, "/tmp/bin.mjs"] }],
    [
      "an entry in a different app than the executable",
      { execPath: "/Applications/Other.app/Contents/MacOS/Other" },
    ],
    ["a dev checkout run through Electron", { argv: [EXECUTABLE, "/repo/apps/server/src/bin.ts"] }],
  ])("is not app mode for %s", (_, overrides) => {
    expect(detect(overrides)).toBeUndefined();
  });
});
