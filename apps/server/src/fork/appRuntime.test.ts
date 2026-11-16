import { describe, expect, it } from "vite-plus/test";

import { appLocationProblem, detectAppRuntime, parseAppRuntimeUnit } from "./appRuntime.ts";

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

describe("appLocationProblem", () => {
  const real = {
    appPath: "/Applications/T3 Extend.app",
    executable: "/Applications/T3 Extend.app/Contents/MacOS/T3 Extend",
    asar: "/Applications/T3 Extend.app/Contents/Resources/app.asar",
  };

  it.each([
    ["a normal bundle", {}, undefined],
    [
      "a bundle on a disk image",
      {
        appPath: "/Volumes/T3 Extend/T3 Extend.app",
        executable: "/Volumes/T3 Extend/T3 Extend.app/Contents/MacOS/T3 Extend",
        asar: "/Volumes/T3 Extend/T3 Extend.app/Contents/Resources/app.asar",
      },
      "transient",
    ],
    [
      "a translocated bundle",
      {
        appPath: "/private/var/folders/x/AppTranslocation/A/d/T3 Extend.app",
        executable:
          "/private/var/folders/x/AppTranslocation/A/d/T3 Extend.app/Contents/MacOS/T3 Extend",
        asar: "/private/var/folders/x/AppTranslocation/A/d/T3 Extend.app/Contents/Resources/app.asar",
      },
      "transient",
    ],
    [
      "an executable linked out of the bundle",
      { executable: "/Applications/Other.app/Contents/MacOS/Other" },
      "mismatch",
    ],
    ["an app.asar linked out of the bundle", { asar: "/tmp/app.asar" }, "mismatch"],
  ])("judges %s", (_, overrides, expected) => {
    expect(appLocationProblem({ ...real, ...overrides })).toBe(expected);
  });
});

describe("parseAppRuntimeUnit", () => {
  const plist = (environment: string) =>
    `<key>ProgramArguments</key>\n<array>\n<string>/A &amp; B.app/Contents/MacOS/x</string>\n<string>/A &amp; B.app/e.mjs</string>\n<string>__service-launcher</string>\n</array>\n<key>EnvironmentVariables</key><dict>${environment}</dict>`;

  it("recognises only a unit carrying the app service marker", () => {
    expect(parseAppRuntimeUnit(plist("<key>T3X_APP_SERVICE</key><string>1</string>"))).toEqual({
      executable: "/A & B.app/Contents/MacOS/x",
      entry: "/A & B.app/e.mjs",
    });
    expect(
      parseAppRuntimeUnit(plist("<key>ELECTRON_RUN_AS_NODE</key><string>1</string>")),
    ).toBeUndefined();
  });
});
