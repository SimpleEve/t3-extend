import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasRunningLocalThread, shouldKeepAwake } from "./keepAwake.logic";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;
const thread = (environmentId: EnvironmentId, status: string | null) => ({
  environmentId,
  runtime: status === null ? null : { status },
});

describe("keep awake", () => {
  it("counts only running threads of the computer's own environment", () => {
    expect(hasRunningLocalThread([thread(remote, "running")], local)).toBe(false);
    expect(hasRunningLocalThread([thread(local, "waiting"), thread(local, "queued")], local)).toBe(
      false,
    );
    expect(hasRunningLocalThread([thread(local, null), thread(local, "starting")], local)).toBe(
      true,
    );
    expect(hasRunningLocalThread([thread(local, "running")], null)).toBe(false);
  });

  it("needs the switch, the desktop bridge, and a running thread", () => {
    const on = { enabled: true, hasBridge: true, localThreadRunning: true };
    expect(shouldKeepAwake(on)).toBe(true);
    expect(shouldKeepAwake({ ...on, enabled: false })).toBe(false);
    expect(shouldKeepAwake({ ...on, hasBridge: false })).toBe(false);
    expect(shouldKeepAwake({ ...on, localThreadRunning: false })).toBe(false);
  });
});
