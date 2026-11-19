import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

// fork: push to a UnifiedPush endpoint (ntfy, etc.) without a relay, Firebase or Clerk.
// The phone sends the endpoint it got from its distributor plus the Web Push keys;
// the environment encrypts each payload (RFC 8291) and posts it there.

export const FORK_PUSH_WS_METHODS = {
  register: "push.register",
  unregister: "push.unregister",
  status: "push.status",
  sendTest: "push.sendTest",
} as const;

/** What the owner chose to be told about, per registered device. */
export const PushNotificationPreferences = Schema.Struct({
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
});
export type PushNotificationPreferences = typeof PushNotificationPreferences.Type;

const Base64UrlKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+={0,2}$/),
  Schema.isMaxLength(128),
);

/** What the Android phone sends. It has no `kind`, so registrations from older builds still decode. */
export const UnifiedPushRegistrationInput = Schema.Struct({
  /** Stable per app install, so a re-paired phone replaces its old registration. */
  deviceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  label: TrimmedString.check(Schema.isMaxLength(100)),
  /** What the phone calls this environment; echoed into notifications. */
  environmentLabel: TrimmedString.check(Schema.isMaxLength(100)),
  /** The distributor's endpoint. It is a credential: anyone holding it can push to the phone. */
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
  /** P-256 public key of the phone's Web Push subscription, base64url. */
  p256dh: Base64UrlKey,
  /** 16-byte Web Push auth secret, base64url. */
  auth: Base64UrlKey,
  preferences: PushNotificationPreferences,
});
export type UnifiedPushRegistrationInput = typeof UnifiedPushRegistrationInput.Type;

/**
 * One alert's wording in the phone's interface language. The environment fills `{thread}`,
 * `{project}` and `{environment}`; an iOS phone has no extension that could format a push, so the
 * server writes the finished text into the alert.
 */
export const ApnsAlertTemplate = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(300)),
  body: Schema.String.check(Schema.isMaxLength(500)),
});
export type ApnsAlertTemplate = typeof ApnsAlertTemplate.Type;

/** A kind left out is worded in English. */
export const ApnsAlertTemplates = Schema.Struct({
  approval: Schema.optional(ApnsAlertTemplate),
  input: Schema.optional(ApnsAlertTemplate),
  completed: Schema.optional(ApnsAlertTemplate),
  failed: Schema.optional(ApnsAlertTemplate),
  test: Schema.optional(ApnsAlertTemplate),
});
export type ApnsAlertTemplates = typeof ApnsAlertTemplates.Type;

export const ApsEnvironment = Schema.Literals(["development", "production"]);
export type ApsEnvironment = typeof ApsEnvironment.Type;

/** What an iOS phone sends: its native APNs token, which this environment pushes to directly. */
export const ApnsPushRegistrationInput = Schema.Struct({
  kind: Schema.Literal("apns"),
  deviceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  label: TrimmedString.check(Schema.isMaxLength(100)),
  environmentLabel: TrimmedString.check(Schema.isMaxLength(100)),
  /** Hex, as the system hands it out. It is a credential for pushing to this app on this phone. */
  deviceToken: Schema.String.check(
    Schema.isPattern(/^[0-9a-fA-F]+$/),
    Schema.isMinLength(32),
    Schema.isMaxLength(200),
  ),
  /** Which Apple host accepts the token: it follows the build's `aps-environment` entitlement. */
  apsEnvironment: ApsEnvironment,
  /** The app's bundle id, sent as `apns-topic`. */
  bundleId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]+$/), Schema.isMaxLength(155)),
  preferences: PushNotificationPreferences,
  templates: Schema.optional(ApnsAlertTemplates),
});
export type ApnsPushRegistrationInput = typeof ApnsPushRegistrationInput.Type;

export const PushRegistrationInput = Schema.Union([
  UnifiedPushRegistrationInput,
  ApnsPushRegistrationInput,
]);
export type PushRegistrationInput = typeof PushRegistrationInput.Type;

export const PushDeviceInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type PushDeviceInput = typeof PushDeviceInput.Type;

export const PushDeliveryOutcome = Schema.Literals([
  "delivered",
  "gone",
  "rejected",
  "unreachable",
]);
export type PushDeliveryOutcome = typeof PushDeliveryOutcome.Type;

/** Never carries the endpoint, token or keys, only the host they lead to. */
export const PushRegistrationStatus = Schema.Struct({
  registered: Schema.Boolean,
  endpointHost: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  lastDelivery: Schema.NullOr(
    Schema.Struct({
      at: Schema.String,
      outcome: PushDeliveryOutcome,
      httpStatus: Schema.NullOr(Schema.Int),
    }),
  ),
});
export type PushRegistrationStatus = typeof PushRegistrationStatus.Type;

export const PushUnregisterResult = Schema.Struct({ removed: Schema.Boolean });
export type PushUnregisterResult = typeof PushUnregisterResult.Type;

export const PushTestResult = Schema.Struct({
  registered: Schema.Boolean,
  outcome: Schema.NullOr(PushDeliveryOutcome),
  httpStatus: Schema.NullOr(Schema.Int),
});
export type PushTestResult = typeof PushTestResult.Type;

export class PushRegistrationError extends Schema.TaggedError<PushRegistrationError>()(
  "PushRegistrationError",
  {
    reason: Schema.Literals([
      "invalid_endpoint",
      "invalid_keys",
      "too_many",
      "storage",
      // fork: an iOS phone registered, but this environment has no APNs key.
      "apns_not_configured",
    ]),
    message: Schema.String,
  },
) {}

const PushRpcError = Schema.Union([PushRegistrationError, EnvironmentAuthorizationError]);

const WsPushRegisterRpc = Rpc.make(FORK_PUSH_WS_METHODS.register, {
  payload: PushRegistrationInput,
  success: PushRegistrationStatus,
  error: PushRpcError,
});
const WsPushUnregisterRpc = Rpc.make(FORK_PUSH_WS_METHODS.unregister, {
  payload: PushDeviceInput,
  success: PushUnregisterResult,
  error: PushRpcError,
});
const WsPushStatusRpc = Rpc.make(FORK_PUSH_WS_METHODS.status, {
  payload: PushDeviceInput,
  success: PushRegistrationStatus,
  error: PushRpcError,
});
const WsPushSendTestRpc = Rpc.make(FORK_PUSH_WS_METHODS.sendTest, {
  payload: PushDeviceInput,
  success: PushTestResult,
  error: PushRpcError,
});

export const FORK_PUSH_RPCS = [
  WsPushRegisterRpc,
  WsPushUnregisterRpc,
  WsPushStatusRpc,
  WsPushSendTestRpc,
] as const;

/**
 * A device is told about the threads it could read anyway, so reading them is the scope. Each
 * device manages only its own registration. The writes are listed in `CLIENT_GUARDED_RPC_SCOPES`
 * so the phone checks the grant on the environment it sends them to.
 */
export const FORK_PUSH_GUARDED_RPC_SCOPES = {
  [FORK_PUSH_WS_METHODS.register]: AuthOrchestrationReadScope,
  [FORK_PUSH_WS_METHODS.unregister]: AuthOrchestrationReadScope,
  [FORK_PUSH_WS_METHODS.sendTest]: AuthOrchestrationReadScope,
} as const;

/** Reading a device's own status is an ordinary read. */
export const FORK_PUSH_READ_RPC_SCOPES = {
  [FORK_PUSH_WS_METHODS.status]: AuthOrchestrationReadScope,
} as const;

/** The plaintext inside each encrypted push. Phones format it in their own language. */
export const PushNotificationKind = Schema.Literals([
  "approval",
  "input",
  "completed",
  "failed",
  "test",
]);
export type PushNotificationKind = typeof PushNotificationKind.Type;

export const PushNotificationPayload = Schema.Struct({
  v: Schema.Literal(1),
  /** Unique per alert, so retries and replays do not show twice. */
  id: Schema.String,
  kind: PushNotificationKind,
  environmentId: Schema.String,
  environmentLabel: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.String,
  projectTitle: Schema.String,
  /** Epoch milliseconds when the thread reached this state. */
  at: Schema.Number,
});
export type PushNotificationPayload = typeof PushNotificationPayload.Type;
