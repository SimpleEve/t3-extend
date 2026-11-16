import { describe, expect, it } from "vite-plus/test";

import {
  backgroundServiceState,
  launchAgentPlistPath,
  comparablePath,
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
  const environment = { T3X_APP_SERVICE: "1", T3CODE_HOME: "/h/.t3extend" };
  const json = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      ProgramArguments: [
        "/A & B.app/Contents/MacOS/x",
        "/A & B.app/Contents/Resources/e.mjs",
        "__service-launcher",
      ],
      EnvironmentVariables: environment,
      ...overrides,
    });
  const raw = `<key>ProgramArguments</key><key>T3X_APP_SERVICE</key><key>T3CODE_HOME</key>`;

  it("reads the program and the home from what plutil printed", () => {
    expect(parseAppServicePlist(json(), raw)).toEqual({
      executable: "/A & B.app/Contents/MacOS/x",
      entry: "/A & B.app/Contents/Resources/e.mjs",
      baseDir: "/h/.t3extend",
    });
  });

  it.each([
    ["no marker", json({ EnvironmentVariables: { T3CODE_HOME: "/h" } }), raw],
    ["marker 0", json({ EnvironmentVariables: { ...environment, T3X_APP_SERVICE: "0" } }), raw],
    [
      "a number for the marker",
      json({ EnvironmentVariables: { ...environment, T3X_APP_SERVICE: 1 } }),
      raw,
    ],
    ["no home", json({ EnvironmentVariables: { T3X_APP_SERVICE: "1" } }), raw],
    ["an empty home", json({ EnvironmentVariables: { ...environment, T3CODE_HOME: "" } }), raw],
    [
      "an extra program argument",
      json({ ProgramArguments: ["a", "b", "__service-launcher", "c"] }),
      raw,
    ],
    ["a different launcher argument", json({ ProgramArguments: ["a", "b", "serve"] }), raw],
    ["a non-string argument", json({ ProgramArguments: ["a", 2, "__service-launcher"] }), raw],
    ["output that is not JSON", "not json", raw],
    ["a JSON array", "[]", raw],
    [
      "T3CODE_HOME written twice (or once more in a comment)",
      json(),
      `${raw}<key>T3CODE_HOME</key>`,
    ],
    ["a marker written twice", json(), `${raw}<key>T3X_APP_SERVICE</key>`],
    ["a program written twice", json(), `${raw}<key>ProgramArguments</key>`],
    ["a key missing from the text", json(), "<key>ProgramArguments</key>"],
  ])("is not ours with %s", (_, plutilJson, rawPlist) => {
    expect(parseAppServicePlist(plutilJson, rawPlist)).toBeUndefined();
  });

  it("splits a path inside an app at the bundle, as a fallback when the path will not resolve", () => {
    expect(splitAppBundle("/Applications/T3 Extend.app/Contents/MacOS/T3 Extend")).toEqual({
      bundle: "/Applications/T3 Extend.app",
      rest: "/Contents/MacOS/T3 Extend",
    });
    expect(splitAppBundle("/Users/x/.t3extend")).toBeUndefined();
  });

  it("compares paths without regard to case, extra slashes, dot segments or a trailing slash", () => {
    expect(comparablePath("/Applications//T3 Extend.app/./Contents/MacOS/")).toBe(
      comparablePath("/applications/t3 extend.app/Contents/x/../MacOS"),
    );
    expect(comparablePath("/a/b")).not.toBe(comparablePath("/a/c"));
  });

  it("is the same service only when the program, entry and home all agree", () => {
    const a = { executable: "/a", entry: "/e", baseDir: "/h" };
    expect(sameAppService(a, { executable: "/A/", entry: "//e", baseDir: "/h/." })).toBe(true);
    for (const other of [{ executable: "/b" }, { entry: "/f" }, { baseDir: "/i" }]) {
      expect(sameAppService(a, { ...a, ...other })).toBe(false);
    }
  });
});
