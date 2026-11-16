import { describe, expect, it } from "vite-plus/test";

import { backgroundServiceView } from "./backgroundService.logic";

describe("backgroundServiceView", () => {
  it.each([
    [null, null],
    [{ kind: "unavailable" }, null],
    [{ kind: "off" }, { status: "off", checked: false, action: null, reason: null }],
    [{ kind: "on" }, { status: "on", checked: true, action: null, reason: null }],
    [
      { kind: "attention", problem: "needs-repair" },
      { status: "needs-repair", checked: true, action: "repair", reason: null },
    ],
    [
      { kind: "attention", problem: "app-missing" },
      { status: "app-missing", checked: true, action: null, reason: null },
    ],
    [
      { kind: "attention", problem: "other-home" },
      { status: "other-home", checked: true, action: null, reason: null },
    ],
    [
      { kind: "attention", problem: "unreadable" },
      { status: "unreadable", checked: false, action: "retry", reason: null },
    ],
    [
      { kind: "attention", problem: "resume-failed", reason: "Bootstrap failed: 5" },
      {
        status: "resume-failed",
        checked: true,
        action: "retry-start",
        reason: "Bootstrap failed: 5",
      },
    ],
  ] as const)("shows %j as %j", (state, expected) => {
    expect(backgroundServiceView(state)).toEqual(expected);
  });
});
