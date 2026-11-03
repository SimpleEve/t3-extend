// When the server file may be believed: a recent heartbeat, and for `tunnel status` a live pid.
import { assert, describe, it } from "@effect/vitest";

import { isServerRunning, isTunnelStatusFresh, type TunnelStatusFile } from "./tunnelStatusFile.ts";

const NOW = 1_800_000_000_000;
const file = (updatedAt: number, serverPid = 4242): TunnelStatusFile => ({
  serverPid,
  frpcPid: null,
  status: "connected",
  lastError: null,
  updatedAt,
});
const alive = () => true;
const dead = () => false;

describe("isServerRunning", () => {
  it("needs both: a recent heartbeat and a live pid", () => {
    assert.isTrue(isServerRunning(file(NOW), NOW, alive));
    assert.isTrue(isServerRunning(file(NOW - 179_999), NOW, alive));
    assert.isTrue(isServerRunning(file(NOW - 180_000), NOW, alive));
    assert.isFalse(
      isServerRunning(file(NOW - 180_001), NOW, alive),
      "three minutes without a heartbeat",
    );
    assert.isFalse(isServerRunning(file(NOW), NOW, dead), "the pid is gone");
    // A reused pid with an old file is not the server.
    assert.isFalse(isServerRunning(file(NOW - 3_600_000), NOW, alive));
  });

  it("does not take a timestamp from the future for a heartbeat", () => {
    assert.isTrue(isServerRunning(file(NOW + 60_000), NOW, alive));
    assert.isFalse(isServerRunning(file(NOW + 60_001), NOW, alive));
  });

  it("asks about the pid the file names", () => {
    const asked: Array<number> = [];
    isServerRunning(file(NOW, 777), NOW, (pid) => (asked.push(pid), true));
    assert.deepEqual(asked, [777]);
  });
});

describe("isTunnelStatusFresh", () => {
  it("is the heartbeat half of isServerRunning, without a pid", () => {
    assert.isTrue(isTunnelStatusFresh(file(NOW - 180_000), NOW));
    assert.isFalse(isTunnelStatusFresh(file(NOW - 180_001), NOW));
    assert.isTrue(isTunnelStatusFresh(file(NOW + 60_000), NOW));
    assert.isFalse(isTunnelStatusFresh(file(NOW + 60_001), NOW));
  });
});
