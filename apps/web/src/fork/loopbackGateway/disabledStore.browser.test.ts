import { describe, expect, it } from "vite-plus/test";

import {
  pruneLoopbackWasActive,
  setLoopbackForwardingDisabled,
  setLoopbackWasActive,
  useGatewayStorage,
} from "./disabledStore";

function setup() {
  window.localStorage.clear();
  useGatewayStorage.setState({ disabled: [], wasActive: [] });
  return () => JSON.parse(window.localStorage.getItem("t3extend:loopback-gateway:v1") ?? "null");
}

describe("gateway storage writes", () => {
  it("keeps each list when the other changes", () => {
    const stored = setup();
    setLoopbackWasActive("env-a", true);
    setLoopbackForwardingDisabled("env-b" as never, true);
    expect(stored()).toEqual({ disabled: ["env-b"], wasActive: ["env-a"] });
    setLoopbackForwardingDisabled("env-b" as never, false);
    expect(stored()).toEqual({ disabled: [], wasActive: ["env-a"] });
  });

  it("forgets environments that are no longer saved", () => {
    const stored = setup();
    setLoopbackWasActive("env-a", true);
    setLoopbackWasActive("env-b", true);
    pruneLoopbackWasActive(new Set(["env-b"]));
    expect(stored().wasActive).toEqual(["env-b"]);
    setLoopbackWasActive("env-b", false);
    expect(stored().wasActive).toEqual([]);
  });
});
