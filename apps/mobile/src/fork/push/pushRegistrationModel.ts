import type { PushRegistrationInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { UnifiedPushNativeState, UnifiedPushSubscription } from "./unifiedPushTypes";

// fork: pure parts of the UnifiedPush registration flow.

/** "waiting": the environment has no connection yet; it is registered once it has one. */
export type EnvironmentPushState = "waiting" | "pending" | "registered" | "failed";

/** Why a registration did not reach the environment; shown next to "Not registered". */
export type PushFailureKind =
  | "unreachable"
  | "denied"
  | "rejected"
  | "invalid"
  | "timeout"
  | "unknown";

export class PushRequestTimeout extends Schema.TaggedError<PushRequestTimeout>()(
  "PushRequestTimeout",
  {},
) {}

/**
 * Sorts a failed `push.register` by its error's `_tag`, never by message: messages can quote the
 * request, which carries the endpoint.
 */
export function classifyPushFailure(error: unknown): PushFailureKind {
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : null;
  switch (tag) {
    case "PushRequestTimeout":
      return "timeout";
    case "EnvironmentAuthorizationError":
      return "denied";
    case "PushRegistrationError":
      return "rejected";
    case "EnvironmentRpcUnavailableError":
    case "EnvironmentNotRegisteredError":
    case "RpcClientError":
    case "ConnectionBlockedError":
      return "unreachable";
    case "SchemaError":
    case "ParseError":
      return "invalid";
    default:
      return "unknown";
  }
}

export interface EnvironmentPushStatus {
  readonly environmentId: string;
  readonly label: string;
  readonly state: EnvironmentPushState;
  /** Only while `state` is "failed". */
  readonly failure?: PushFailureKind;
  readonly lastDelivery: "delivered" | "gone" | "rejected" | "unreachable" | null;
}

export interface UnifiedPushUiState {
  readonly supported: boolean;
  readonly native: UnifiedPushNativeState;
  readonly environments: ReadonlyArray<EnvironmentPushStatus>;
}

/**
 * The preferences mirror what the relay path sends for a phone: every kind on, with the master
 * switch following the system notification permission (upstream's per-device behaviour).
 */
export function makePushRegistrationInput(input: {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly environmentLabel: string;
  readonly subscription: UnifiedPushSubscription;
  readonly notificationsEnabled: boolean;
}): PushRegistrationInput {
  return {
    deviceId: input.deviceId,
    label: input.deviceLabel,
    environmentLabel: input.environmentLabel,
    endpoint: input.subscription.endpoint,
    p256dh: input.subscription.p256dh,
    auth: input.subscription.auth,
    preferences: {
      notificationsEnabled: input.notificationsEnabled,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
  };
}

/** Same key means the environment already has this exact registration. */
export function registrationKey(input: PushRegistrationInput): string {
  return JSON.stringify([
    input.endpoint,
    input.p256dh,
    input.auth,
    input.environmentLabel,
    input.label,
    input.preferences,
  ]);
}

/** What the phone needs to be told and what it can do next, from the settings screen's view. */
export type UnifiedPushSetupStep =
  | "unsupported"
  | "install-distributor"
  | "choose-distributor"
  | "waiting-for-endpoint"
  | "ready";

export function unifiedPushSetupStep(state: UnifiedPushUiState): UnifiedPushSetupStep {
  if (!state.supported) return "unsupported";
  const { native } = state;
  if (native.distributors.length === 0) return "install-distributor";
  if (native.distributor === null) return "choose-distributor";
  return native.endpointHost === null || !native.hasKeys ? "waiting-for-endpoint" : "ready";
}

/**
 * With one distributor installed there is nothing to choose, so it is picked for the user.
 * Several installed ones need a decision, which a saved choice that is still installed settles.
 */
export function distributorToAutoSelect(native: UnifiedPushNativeState): string | null {
  if (native.distributor !== null) return null;
  return native.distributors.length === 1 ? native.distributors[0]!.id : null;
}
