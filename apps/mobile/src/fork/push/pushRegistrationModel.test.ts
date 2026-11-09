import { describe, expect, it } from "vite-plus/test";

import {
  classifyPushFailure,
  distributorToAutoSelect,
  makePushRegistrationInput,
  registrationKey,
  unifiedPushSetupStep,
  type UnifiedPushUiState,
} from "./pushRegistrationModel";
import { NO_NATIVE_STATE } from "./unifiedPushTypes";

const ui = (native: Partial<typeof NO_NATIVE_STATE>, supported = true): UnifiedPushUiState => ({
  supported,
  native: { ...NO_NATIVE_STATE, ...native },
  environments: [],
});
const ntfy = { id: "io.heckel.ntfy", label: "ntfy" };

describe("unifiedPushSetupStep", () => {
  it("guides from nothing installed to a working endpoint", () => {
    expect(unifiedPushSetupStep(ui({}, false))).toBe("unsupported");
    expect(unifiedPushSetupStep(ui({}))).toBe("install-distributor");
    expect(unifiedPushSetupStep(ui({ distributors: [ntfy] }))).toBe("choose-distributor");
    expect(unifiedPushSetupStep(ui({ distributors: [ntfy], distributor: ntfy.id }))).toBe(
      "waiting-for-endpoint",
    );
    expect(
      unifiedPushSetupStep(
        ui({
          distributors: [ntfy],
          distributor: ntfy.id,
          endpointHost: "ntfy.example.com",
          hasKeys: true,
        }),
      ),
    ).toBe("ready");
  });
});

describe("distributorToAutoSelect", () => {
  it("picks the only installed distributor and leaves a real choice to the user", () => {
    expect(distributorToAutoSelect({ ...NO_NATIVE_STATE, distributors: [ntfy] })).toBe(ntfy.id);
    expect(
      distributorToAutoSelect({
        ...NO_NATIVE_STATE,
        distributors: [ntfy, { id: "org.example", label: "Other" }],
      }),
    ).toBeNull();
    expect(
      distributorToAutoSelect({ ...NO_NATIVE_STATE, distributors: [ntfy], distributor: ntfy.id }),
    ).toBeNull();
  });
});

describe("registration input", () => {
  const base = {
    deviceId: "device-1",
    deviceLabel: "Pixel",
    environmentLabel: "Mac mini",
    subscription: { endpoint: "https://ntfy.example.com/upA", p256dh: "pk", auth: "au" },
    notificationsEnabled: true,
  };

  it("sends every kind on and follows the system permission for the master switch", () => {
    expect(makePushRegistrationInput(base).preferences).toEqual({
      notificationsEnabled: true,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    });
    expect(
      makePushRegistrationInput({ ...base, notificationsEnabled: false }).preferences
        .notificationsEnabled,
    ).toBe(false);
  });

  it("changes its key when the endpoint, label or preferences change", () => {
    const key = registrationKey(makePushRegistrationInput(base));
    expect(registrationKey(makePushRegistrationInput(base))).toBe(key);
    expect(
      registrationKey(
        makePushRegistrationInput({
          ...base,
          subscription: { ...base.subscription, endpoint: "https://ntfy.example.com/upB" },
        }),
      ),
    ).not.toBe(key);
    expect(
      registrationKey(makePushRegistrationInput({ ...base, environmentLabel: "Studio" })),
    ).not.toBe(key);
    expect(
      registrationKey(makePushRegistrationInput({ ...base, notificationsEnabled: false })),
    ).not.toBe(key);
  });
});

describe("classifyPushFailure", () => {
  it.each([
    ["PushRequestTimeout", "timeout"],
    ["EnvironmentAuthorizationError", "denied"],
    ["PushRegistrationError", "rejected"],
    ["EnvironmentRpcUnavailableError", "unreachable"],
    ["RpcClientError", "unreachable"],
    ["SchemaError", "invalid"],
    ["SomethingElse", "unknown"],
  ] as const)("sorts %s as %s", (tag, expected) => {
    expect(classifyPushFailure({ _tag: tag, message: "quotes the endpoint" })).toBe(expected);
  });

  it("does not guess from the message or from non-errors", () => {
    expect(classifyPushFailure(new Error("timed out"))).toBe("unknown");
    expect(classifyPushFailure(null)).toBe("unknown");
  });
});
