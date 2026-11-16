import { describe, expect, it } from "vite-plus/test";

import { backgroundServiceView } from "./backgroundService.logic";

describe("backgroundServiceView", () => {
  it.each([
    [null, null],
    [{ kind: "unavailable" }, null],
    [{ kind: "off" }, { status: "off", checked: false, action: null }],
    [{ kind: "on" }, { status: "on", checked: true, action: null }],
    [
      { kind: "attention", problem: "needs-repair" },
      { status: "needs-repair", checked: true, action: "repair" },
    ],
    [
      { kind: "attention", problem: "app-missing" },
      { status: "app-missing", checked: true, action: null },
    ],
    [
      { kind: "attention", problem: "other-home" },
      { status: "other-home", checked: true, action: null },
    ],
    [
      { kind: "attention", problem: "unreadable" },
      { status: "unreadable", checked: false, action: "retry" },
    ],
  ] as const)("shows %j as %j", (state, expected) => {
    expect(backgroundServiceView(state)).toEqual(expected);
  });
});
