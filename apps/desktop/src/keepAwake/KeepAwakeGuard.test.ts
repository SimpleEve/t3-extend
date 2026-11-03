import { describe, expect, it } from "vite-plus/test";

import { makeKeepAwakeGuard } from "./KeepAwakeGuard.ts";

function setup() {
  const calls: string[] = [];
  let next = 0;
  const guard = makeKeepAwakeGuard({
    start: () => {
      calls.push("start");
      return ++next;
    },
    stop: (id) => calls.push(`stop:${id}`),
  });
  return { guard, calls };
}

describe("keep-awake guard", () => {
  it("holds one blocker while any renderer reports running, and only the latest report counts", () => {
    const { guard, calls } = setup();
    guard.report(1, true);
    guard.report(1, true);
    guard.report(2, true);
    expect(calls).toEqual(["start"]);
    guard.report(1, false);
    expect(guard.isHeld()).toBe(true);
    guard.report(2, false);
    expect(calls).toEqual(["start", "stop:1"]);
  });

  it("treats a renderer that goes away as not running", () => {
    const { guard, calls } = setup();
    guard.report(7, true);
    guard.drop(7);
    expect(calls).toEqual(["start", "stop:1"]);
    guard.drop(7);
    expect(calls).toEqual(["start", "stop:1"]);
  });

  it("releases everything on quit and can start again afterwards", () => {
    const { guard, calls } = setup();
    guard.report(1, true);
    guard.report(2, true);
    guard.releaseAll();
    expect(guard.isHeld()).toBe(false);
    guard.report(1, true);
    expect(calls).toEqual(["start", "stop:1", "start"]);
  });
});
