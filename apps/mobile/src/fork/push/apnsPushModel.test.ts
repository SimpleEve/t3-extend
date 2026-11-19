import { setUiLocale } from "@t3tools/client-runtime/i18n";
import { PushRegistrationInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  alertTemplatesOf,
  apnsRegistrationKey,
  apnsSetupStep,
  apnsSupport,
  classifyApnsFailure,
  makeApnsRegistrationInput,
  resolveApnsEnvironment,
} from "./apnsPushModel";
import { buildPushTemplateSet } from "./pushTemplates";

const decodeRegistration = Schema.decodeSync(PushRegistrationInput);

afterEach(() => setUiLocale("en"));

const input = (overrides: Partial<Parameters<typeof makeApnsRegistrationInput>[0]> = {}) =>
  makeApnsRegistrationInput({
    deviceId: "device-1",
    deviceLabel: "iPhone",
    environmentLabel: "Mac mini",
    deviceToken: "ab".repeat(32),
    apsEnvironment: "production",
    bundleId: "com.example.app",
    templates: alertTemplatesOf(buildPushTemplateSet("en")),
    notificationsEnabled: true,
    ...overrides,
  });

describe("apnsSupport", () => {
  it("is off for a free Apple account build and for other platforms", () => {
    expect(apnsSupport({ platform: "ios", personalTeamBuild: undefined })).toBe("supported");
    expect(apnsSupport({ platform: "ios", personalTeamBuild: false })).toBe("supported");
    expect(apnsSupport({ platform: "ios", personalTeamBuild: true })).toBe("free-account");
    expect(apnsSupport({ platform: "android", personalTeamBuild: undefined })).toBe(
      "unsupported-platform",
    );
  });
});

describe("resolveApnsEnvironment", () => {
  it("uses Apple's sandbox for development builds only", () => {
    expect(resolveApnsEnvironment("development")).toBe("development");
    expect(resolveApnsEnvironment("production")).toBe("production");
    expect(resolveApnsEnvironment(undefined)).toBe("production");
  });
});

describe("makeApnsRegistrationInput", () => {
  it("is a registration the contract accepts, wording included", () => {
    const decoded = decodeRegistration(input());
    expect("kind" in decoded && decoded.kind).toBe("apns");
  });

  it("carries the phone's wording, with the placeholders the server fills", () => {
    const templates = input().templates;
    expect(templates?.approval).toEqual({
      title: "{thread}",
      body: "Approval needed · {project} · {environment}",
    });
    expect(Object.keys(templates ?? {}).sort()).toEqual([
      "approval",
      "completed",
      "failed",
      "input",
      "test",
    ]);
  });

  it("follows the notification permission for the master switch only", () => {
    expect(input({ notificationsEnabled: false }).preferences).toEqual({
      notificationsEnabled: false,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    });
  });
});

describe("apnsRegistrationKey", () => {
  it("changes with the token, the language and the permission, so each is sent again", async () => {
    await setUiLocale("zh-Hans");
    const base = apnsRegistrationKey(input());
    expect(apnsRegistrationKey(input())).toBe(base);
    expect(apnsRegistrationKey(input({ deviceToken: "cd".repeat(32) }))).not.toBe(base);
    expect(
      apnsRegistrationKey(input({ templates: alertTemplatesOf(buildPushTemplateSet("zh-Hans")) })),
    ).not.toBe(base);
    expect(apnsRegistrationKey(input({ notificationsEnabled: false }))).not.toBe(base);
  });
});

describe("classifyApnsFailure", () => {
  it("tells a server without an APNs key from any other refusal, by reason", () => {
    expect(
      classifyApnsFailure({ _tag: "PushRegistrationError", reason: "apns_not_configured" }),
    ).toBe("not-configured");
    expect(classifyApnsFailure({ _tag: "PushRegistrationError", reason: "too_many" })).toBe(
      "rejected",
    );
    expect(classifyApnsFailure({ _tag: "EnvironmentAuthorizationError" })).toBe("denied");
    expect(classifyApnsFailure({ _tag: "PushRequestTimeout" })).toBe("timeout");
  });
});

describe("apnsSetupStep", () => {
  const base = {
    support: "supported",
    enabled: true,
    permission: "granted",
    tokenFailed: false,
  } as const;

  it("explains a free account before anything else, and never asks for a token", () => {
    expect(apnsSetupStep({ ...base, support: "free-account" })).toBe("free-account");
    expect(apnsSetupStep({ ...base, support: "unsupported-platform" })).toBe("unsupported");
  });

  it("walks from off to ready", () => {
    expect(apnsSetupStep({ ...base, enabled: false })).toBe("off");
    expect(apnsSetupStep({ ...base, tokenFailed: true })).toBe("token-failed");
    expect(apnsSetupStep({ ...base, permission: "denied" })).toBe("permission-denied");
    expect(apnsSetupStep(base)).toBe("ready");
  });
});
