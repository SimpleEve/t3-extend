import { describe, expect, it } from "vite-plus/test";

import {
  backgroundServiceState,
  launchAgentPlistPath,
  launchdServiceTarget,
  parseAppServicePlist,
  parseCliServiceStatus,
  parseResumeFailure,
  sameAppService,
  splitAppBundle,
} from "./backgroundService.logic.ts";

const installed = { supported: true, installed: true, current: true, problems: [] };

describe("backgroundServiceState", () => {
  it.each([
    ["not installed", { supported: true, installed: false, current: false }, { kind: "off" }],
    ["installed and current", installed, { kind: "on" }],
    [
      "launchd has not loaded it right now (the app holds the home while it is open)",
      { ...installed, running: false },
      { kind: "on" },
    ],
    [
      "installed by another home",
      { ...installed, current: false, otherBaseDir: "/Users/x/.t3" },
      { kind: "attention", problem: "other-home" },
    ],
    [
      "the app it runs from is gone",
      { ...installed, current: false, problems: ["app-runtime-missing"] },
      { kind: "attention", problem: "app-missing" },
    ],
    [
      "installed for another app version",
      { ...installed, current: false },
      { kind: "attention", problem: "needs-repair" },
    ],
    [
      "a platform without a service manager",
      { supported: false, installed: false },
      { kind: "unavailable" },
    ],
    ["no status at all", undefined, { kind: "attention", problem: "unreadable" }],
  ])("maps %s", (_, status, expected) => {
    expect(backgroundServiceState(status)).toEqual(expected);
  });
});

describe("parseCliServiceStatus", () => {
  it("reads the JSON line the status command prints after any log noise", () => {
    expect(parseCliServiceStatus(`some log\n${JSON.stringify(installed)}\n`)).toEqual(installed);
  });

  it.each(["", "not json", "[]", '{"installed":"yes"}', '{"supported":true}'])(
    "rejects %j",
    (stdout) => {
      expect(parseCliServiceStatus(stdout)).toBeUndefined();
    },
  );
});

describe("launchd names", () => {
  it("uses this app's label, never the official one", () => {
    expect(launchdServiceTarget(501)).toBe("gui/501/com.simpleeve.t3extend.service");
    expect(launchAgentPlistPath("/Users/theo")).toBe(
      "/Users/theo/Library/LaunchAgents/com.simpleeve.t3extend.service.plist",
    );
  });
});

describe("a failed start at the last quit", () => {
  const failure = { at: "2026-11-16T00:00:00.000Z", reason: "Bootstrap failed: 5" };

  it("outranks an otherwise fine service, but not a missing or broken one", () => {
    expect(backgroundServiceState(installed, failure)).toEqual({
      kind: "attention",
      problem: "resume-failed",
      reason: "Bootstrap failed: 5",
    });
    expect(backgroundServiceState({ supported: true, installed: false }, failure)).toEqual({
      kind: "off",
    });
    expect(backgroundServiceState({ ...installed, current: false }, failure)).toEqual({
      kind: "attention",
      problem: "needs-repair",
    });
  });

  it("is read back from the file, and a damaged file is no failure", () => {
    expect(parseResumeFailure(JSON.stringify(failure))).toEqual(failure);
    for (const text of ["", "{", "[]", '{"at":1,"reason":"x"}', '{"at":"x"}']) {
      expect(parseResumeFailure(text)).toBeUndefined();
    }
  });
});

describe("the app's own service", () => {
  const plist = (marker: string) =>
    `<key>ProgramArguments</key><array><string>/A &amp; B.app/Contents/MacOS/x</string><string>/A &amp; B.app/Contents/Resources/e.mjs</string></array><key>EnvironmentVariables</key><dict><key>T3CODE_HOME</key><string>/h/.t3extend</string>${marker}</dict>`;

  it("is recognised only by the marker, and reads the program and the home", () => {
    expect(parseAppServicePlist(plist("<key>T3X_APP_SERVICE</key><string>1</string>"))).toEqual({
      executable: "/A & B.app/Contents/MacOS/x",
      entry: "/A & B.app/Contents/Resources/e.mjs",
      baseDir: "/h/.t3extend",
    });
    expect(
      parseAppServicePlist(plist("<key>ELECTRON_RUN_AS_NODE</key><string>1</string>")),
    ).toBeUndefined();
    expect(
      parseAppServicePlist(plist("<key>T3X_APP_SERVICE</key><string>0</string>")),
    ).toBeUndefined();
  });

  it("splits a path inside an app at the bundle, so links resolve on the bundle alone", () => {
    expect(splitAppBundle("/Applications/T3 Extend.app/Contents/MacOS/T3 Extend")).toEqual({
      bundle: "/Applications/T3 Extend.app",
      rest: "/Contents/MacOS/T3 Extend",
    });
    expect(splitAppBundle("/Users/x/.t3extend")).toBeUndefined();
  });

  it("is the same service only when the program, entry and home all agree", () => {
    const a = { executable: "/a", entry: "/e", baseDir: "/h" };
    expect(sameAppService(a, { ...a })).toBe(true);
    for (const other of [{ executable: "/b" }, { entry: "/f" }, { baseDir: "/i" }]) {
      expect(sameAppService(a, { ...a, ...other })).toBe(false);
    }
  });
});
