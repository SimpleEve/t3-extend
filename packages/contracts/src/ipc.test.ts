import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopUpdateStateSchema, type DesktopUpdateState } from "./ipc.ts";

const encodeState = Schema.encodeSync(DesktopUpdateStateSchema);
const decodeState = Schema.decodeUnknownSync(DesktopUpdateStateSchema);

const state: DesktopUpdateState = {
  enabled: false,
  status: "disabled",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: "Automatic updates are not available because no update feed is configured.",
  errorContext: null,
  canRetry: false,
  notAppliedVersion: "1.0.1",
  channelBlockedByPolicy: true,
  messageFixed: true,
};

describe("DesktopUpdateStateSchema", () => {
  // The IPC handlers encode their results with this schema, so a field it lacks never reaches the UI.
  it("keeps every optional field of the state across encoding and decoding", () => {
    const encoded = encodeState(state);
    expect(encoded).toEqual(state);
    const decoded: DesktopUpdateState = decodeState(encoded);
    expect(decoded).toEqual(state);
  });
});
