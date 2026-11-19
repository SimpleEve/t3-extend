import type { ApnsPushRegistrationInput, ApsEnvironment } from "@t3tools/contracts";

import type { PushFailureKind } from "./pushRegistrationModel";
import { classifyPushFailure } from "./pushRegistrationModel";
import type { buildPushTemplateSet } from "./pushTemplates";

// fork: pure parts of the iPhone push flow: this phone's native APNs token, sent to each
// environment, which pushes to Apple directly.

/** "free-account": a build signed with a free Apple account has no push capability at all. */
export type ApnsSupport = "supported" | "free-account" | "unsupported-platform";

export function apnsSupport(input: {
  readonly platform: string;
  readonly personalTeamBuild: unknown;
}): ApnsSupport {
  if (input.platform !== "ios") return "unsupported-platform";
  return input.personalTeamBuild === true ? "free-account" : "supported";
}

/**
 * Development builds carry the development `aps-environment` and get tokens for Apple's sandbox;
 * everything else is production. The environment tells the two hosts apart from this alone.
 */
export function resolveApnsEnvironment(appVariant: unknown): ApsEnvironment {
  return appVariant === "development" ? "development" : "production";
}

/** Why an environment could not be given this phone's token. */
export type ApnsFailureKind = PushFailureKind | "not-configured";

/** By the error's `_tag` and `reason`, never its message: a message could quote the token. */
export function classifyApnsFailure(error: unknown): ApnsFailureKind {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "PushRegistrationError" &&
    "reason" in error &&
    error.reason === "apns_not_configured"
  ) {
    return "not-configured";
  }
  return classifyPushFailure(error);
}

export interface ApnsEnvironmentStatus {
  readonly environmentId: string;
  readonly label: string;
  readonly state: "waiting" | "pending" | "registered" | "failed";
  /** Only while `state` is "failed". */
  readonly failure?: ApnsFailureKind;
  readonly lastDelivery: "delivered" | "gone" | "rejected" | "unreachable" | null;
}

type TemplateSet = ReturnType<typeof buildPushTemplateSet>;

/** The wording the server fills in; the interface language it was translated into travels with it. */
export function alertTemplatesOf(
  set: TemplateSet,
): NonNullable<ApnsPushRegistrationInput["templates"]> {
  return {
    approval: set.approval,
    input: set.input,
    completed: set.completed,
    failed: set.failed,
    test: set.test,
  };
}

/** Preferences mirror the Android path: every kind on, the master switch following the permission. */
export function makeApnsRegistrationInput(input: {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly environmentLabel: string;
  readonly deviceToken: string;
  readonly apsEnvironment: ApsEnvironment;
  readonly bundleId: string;
  readonly templates: ApnsPushRegistrationInput["templates"];
  readonly notificationsEnabled: boolean;
}): ApnsPushRegistrationInput {
  return {
    kind: "apns",
    deviceId: input.deviceId,
    label: input.deviceLabel,
    environmentLabel: input.environmentLabel,
    deviceToken: input.deviceToken,
    apsEnvironment: input.apsEnvironment,
    bundleId: input.bundleId,
    ...(input.templates === undefined ? {} : { templates: input.templates }),
    preferences: {
      notificationsEnabled: input.notificationsEnabled,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
  };
}

/** Same key means the environment already has this exact registration, wording included. */
export function apnsRegistrationKey(input: ApnsPushRegistrationInput): string {
  return JSON.stringify([
    input.deviceToken,
    input.apsEnvironment,
    input.bundleId,
    input.environmentLabel,
    input.label,
    input.preferences,
    input.templates ?? null,
  ]);
}

/** What the Settings section offers, from where the phone stands. */
export type ApnsSetupStep =
  | "unsupported"
  | "free-account"
  | "off"
  | "permission-denied"
  | "token-failed"
  | "ready";

export function apnsSetupStep(input: {
  readonly support: ApnsSupport;
  readonly enabled: boolean;
  readonly permission: "unknown" | "granted" | "denied";
  readonly tokenFailed: boolean;
}): ApnsSetupStep {
  if (input.support === "unsupported-platform") return "unsupported";
  if (input.support === "free-account") return "free-account";
  if (!input.enabled) return "off";
  if (input.tokenFailed) return "token-failed";
  return input.permission === "denied" ? "permission-denied" : "ready";
}
