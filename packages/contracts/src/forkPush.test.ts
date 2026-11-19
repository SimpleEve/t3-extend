import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PushRegistrationInput } from "./forkPush.ts";

const decode = Schema.decodeUnknownSync(PushRegistrationInput);
const preferences = {
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const common = { deviceId: "device-1", label: "Phone", environmentLabel: "Mac mini", preferences };
const apns = {
  ...common,
  kind: "apns",
  deviceToken: "ab".repeat(32),
  apsEnvironment: "production",
  bundleId: "com.example.app",
};

describe("push registration input", () => {
  it("still decodes what an Android build without a kind sends", () => {
    const decoded = decode({
      ...common,
      endpoint: "https://ntfy.example.test/upTopic",
      p256dh: "BAAA",
      auth: "AAAA",
    });
    assert.equal("kind" in decoded, false);
  });

  it("decodes an iPhone registration, with or without alert templates", () => {
    const decoded = decode(apns);
    assert.equal("kind" in decoded && decoded.kind, "apns");
    const withTemplates = decode({
      ...apns,
      templates: { approval: { title: "{thread}", body: "需要批准" } },
    });
    assert.equal(
      "templates" in withTemplates && withTemplates.templates?.approval?.body,
      "需要批准",
    );
  });

  it.each([
    ["a token that is not hex", { deviceToken: "zz".repeat(32) }],
    ["a token that is too short", { deviceToken: "ab" }],
    ["an unknown aps environment", { apsEnvironment: "sandbox" }],
    ["a bundle id with a path in it", { bundleId: "com.example/app" }],
  ])("refuses %s", (_name, override) => {
    assert.throws(() => decode({ ...apns, ...override }));
  });
});
