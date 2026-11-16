import { describe, expect, it } from "vite-plus/test";

import {
  backgroundServiceState,
  launchAgentPlistPath,
  launchdServiceTarget,
  parseCliServiceStatus,
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
