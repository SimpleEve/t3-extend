import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// fork: per-device keys for self-hosted pairing (research/self-host-device-keys.md).
// Everything here is wire format: the `devices.*` RPCs a desktop renderer calls on its own
// server, and the registry's JSON as phones and computers read it.

/**
 * The connection profile `authorization` a device-managed environment carries, and what a resolver
 * stamps on `PreparedConnection.authorizer` (client-runtime, design Q10). Used from 8.4 on.
 * @public
 */
export const T3X_DEVICE_AUTHORIZATION = "t3x-device" as const;
/** `POST` target on the computer, form-encoded; the grant is RFC 7523's. */
export const T3X_DEVICE_TOKEN_PATH = "/oauth/t3x-device" as const;
export const T3X_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer" as const;
/** Session subjects look like `t3x-device:<kind>:<device id>`. */
export const T3X_DEVICE_SUBJECT_PREFIX = "t3x-device:" as const;
/** The only session subject allowed to manage devices: the desktop app's own bootstrap grant. */
export const T3X_LOCAL_OWNER_SUBJECT = "desktop-bootstrap" as const;

export const FORK_DEVICE_KEYS_WS_METHODS = {
  status: "devices.status",
  subscribe: "devices.subscribe",
  join: "devices.join",
  leave: "devices.leave",
  invite: "devices.invite",
  cancelInvite: "devices.cancelInvite",
  remove: "devices.remove",
  rename: "devices.rename",
  refresh: "devices.refresh",
  signAssertion: "devices.signAssertion",
} as const;

export const DeviceKind = Schema.Literals(["computer", "phone"]);
export type DeviceKind = typeof DeviceKind.Type;

/** How trustworthy the cached device list is (design Q8). */
export const DeviceListStaleness = Schema.Literals(["fresh", "warn", "expired", "unavailable"]);
export type DeviceListStaleness = typeof DeviceListStaleness.Type;

export const DeviceJwkSchema = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
});
export type DeviceJwkSchema = typeof DeviceJwkSchema.Type;

// Registry wire format (3.3). Phones decode these directly.
export const RegistryDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: DeviceKind,
  jwk: DeviceJwkSchema,
  subdomain: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
  lastSeenAt: Schema.Number,
  lastSyncAt: Schema.optionalKey(Schema.Number),
  online: Schema.optionalKey(Schema.Boolean),
});
export type RegistryDevice = typeof RegistryDevice.Type;

export const RegistryDevicesResponse = Schema.Struct({
  registryId: Schema.String,
  rev: Schema.Number,
  devices: Schema.Array(RegistryDevice),
});
export type RegistryDevicesResponse = typeof RegistryDevicesResponse.Type;

export const RegistryInfo = Schema.Struct({
  apiVersion: Schema.Literal(1),
  registryId: Schema.String,
  domain: Schema.String,
  publicPort: Schema.Number,
});
export type RegistryInfo = typeof RegistryInfo.Type;

export const RegistryJoinResponse = Schema.Struct({
  registryId: Schema.String,
  deviceId: Schema.String,
  name: Schema.String,
  subdomain: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  rev: Schema.Number,
});
export type RegistryJoinResponse = typeof RegistryJoinResponse.Type;

// What the desktop UI sees.
export const DeviceListEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: DeviceKind,
  subdomain: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  online: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.Number,
  lastSeenAt: Schema.Number,
  /** This computer. */
  self: Schema.Boolean,
});
export type DeviceListEntry = typeof DeviceListEntry.Type;

export const DeviceTunnelStatus = Schema.Struct({
  status: Schema.Literals(["disabled", "stopped", "connecting", "connected", "error"]),
  lastError: Schema.NullOr(Schema.String),
});
export type DeviceTunnelStatus = typeof DeviceTunnelStatus.Type;

export const DevicesStatus = Schema.Struct({
  /** `removed`: the registry told this computer it is no longer a member; cleared by joining again. */
  state: Schema.Literals(["not_joined", "joined", "removed"]),
  registryOrigin: Schema.NullOr(Schema.String),
  registryHost: Schema.NullOr(Schema.String),
  deviceId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  tunnel: DeviceTunnelStatus,
  /** Epoch seconds of the last successful sync (200 or 304). */
  fetchedAt: Schema.NullOr(Schema.Number),
  staleness: DeviceListStaleness,
});
export type DevicesStatus = typeof DevicesStatus.Type;

export const DevicesSnapshot = Schema.Struct({
  status: DevicesStatus,
  rev: Schema.NullOr(Schema.Number),
  devices: Schema.Array(DeviceListEntry),
});
export type DevicesSnapshot = typeof DevicesSnapshot.Type;

export const DevicesJoinInput = Schema.Struct({
  invite: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type DevicesJoinInput = typeof DevicesJoinInput.Type;

export const DevicesInviteInput = Schema.Struct({ kind: DeviceKind });
export type DevicesInviteInput = typeof DevicesInviteInput.Type;

export const DevicesInviteResult = Schema.Struct({
  id: Schema.String,
  invite: Schema.String,
  expiresAt: Schema.Number,
});
export type DevicesInviteResult = typeof DevicesInviteResult.Type;

export const DevicesCancelInviteInput = Schema.Struct({ id: Schema.String });
export type DevicesCancelInviteInput = typeof DevicesCancelInviteInput.Type;

export const DevicesRemoveInput = Schema.Struct({ deviceId: Schema.String });
export type DevicesRemoveInput = typeof DevicesRemoveInput.Type;

export const DevicesRemoveResult = Schema.Struct({
  removedAt: Schema.Number,
  rev: Schema.Number,
  /** Computers that have not synced since the removal; they revoke the sessions once they do. */
  pendingComputers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
export type DevicesRemoveResult = typeof DevicesRemoveResult.Type;

export const DevicesRenameInput = Schema.Struct({
  deviceId: Schema.String,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type DevicesRenameInput = typeof DevicesRenameInput.Type;

export const DevicesRenameResult = Schema.Struct({ id: Schema.String, name: Schema.String });
export type DevicesRenameResult = typeof DevicesRenameResult.Type;

export const DevicesSignAssertionInput = Schema.Struct({
  audienceEnvironmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  dpopThumbprint: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
export type DevicesSignAssertionInput = typeof DevicesSignAssertionInput.Type;

export const DevicesSignAssertionResult = Schema.Struct({
  assertion: Schema.String,
  expiresAt: Schema.Number,
});
export type DevicesSignAssertionResult = typeof DevicesSignAssertionResult.Type;

export class DeviceKeysError extends Schema.TaggedError<DeviceKeysError>()("DeviceKeysError", {
  reason: Schema.Literals([
    "not_local_owner",
    "not_joined",
    "already_joined",
    "list_expired",
    "unknown_audience",
    "rate_limited",
    "invite_invalid",
    "invalid_input",
    "registry_unreachable",
    "registry_rejected",
    "storage",
  ]),
  /** The registry's `error` code when `reason` is `registry_rejected`. */
  registryCode: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

const DeviceRpcError = Schema.Union([DeviceKeysError, EnvironmentAuthorizationError]);

const WsDevicesStatusRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.status, {
  payload: Schema.Struct({}),
  success: DevicesStatus,
  error: DeviceRpcError,
});
const WsDevicesSubscribeRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: DevicesSnapshot,
  error: DeviceRpcError,
  stream: true,
});
const WsDevicesJoinRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.join, {
  payload: DevicesJoinInput,
  success: DevicesStatus,
  error: DeviceRpcError,
});
const WsDevicesLeaveRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.leave, {
  payload: Schema.Struct({}),
  success: DevicesStatus,
  error: DeviceRpcError,
});
const WsDevicesInviteRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.invite, {
  payload: DevicesInviteInput,
  success: DevicesInviteResult,
  error: DeviceRpcError,
});
const WsDevicesCancelInviteRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.cancelInvite, {
  payload: DevicesCancelInviteInput,
  success: Schema.Struct({}),
  error: DeviceRpcError,
});
const WsDevicesRemoveRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.remove, {
  payload: DevicesRemoveInput,
  success: DevicesRemoveResult,
  error: DeviceRpcError,
});
const WsDevicesRenameRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.rename, {
  payload: DevicesRenameInput,
  success: DevicesRenameResult,
  error: DeviceRpcError,
});
const WsDevicesRefreshRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.refresh, {
  payload: Schema.Struct({}),
  success: DevicesStatus,
  error: DeviceRpcError,
});
const WsDevicesSignAssertionRpc = Rpc.make(FORK_DEVICE_KEYS_WS_METHODS.signAssertion, {
  payload: DevicesSignAssertionInput,
  success: DevicesSignAssertionResult,
  error: DeviceRpcError,
});

export const FORK_DEVICE_KEYS_RPCS = [
  WsDevicesStatusRpc,
  WsDevicesSubscribeRpc,
  WsDevicesJoinRpc,
  WsDevicesLeaveRpc,
  WsDevicesInviteRpc,
  WsDevicesCancelInviteRpc,
  WsDevicesRemoveRpc,
  WsDevicesRenameRpc,
  WsDevicesRefreshRpc,
  WsDevicesSignAssertionRpc,
] as const;

/**
 * Scopes are only an availability hint for clients. The server's real gate is the session subject
 * (`desktop-bootstrap`), which no grant of scopes can imitate: pairing-link browsers and device
 * sessions hold `access:write` and are still refused.
 */
export const FORK_DEVICE_KEYS_GUARDED_RPC_SCOPES = {
  [FORK_DEVICE_KEYS_WS_METHODS.join]: AuthAccessWriteScope,
  [FORK_DEVICE_KEYS_WS_METHODS.leave]: AuthAccessWriteScope,
  [FORK_DEVICE_KEYS_WS_METHODS.invite]: AuthAccessWriteScope,
  [FORK_DEVICE_KEYS_WS_METHODS.cancelInvite]: AuthAccessWriteScope,
  [FORK_DEVICE_KEYS_WS_METHODS.remove]: AuthAccessWriteScope,
  [FORK_DEVICE_KEYS_WS_METHODS.rename]: AuthAccessWriteScope,
  [FORK_DEVICE_KEYS_WS_METHODS.refresh]: AuthAccessWriteScope,
  [FORK_DEVICE_KEYS_WS_METHODS.signAssertion]: AuthAccessWriteScope,
} as const;

export const FORK_DEVICE_KEYS_READ_RPC_SCOPES = {
  [FORK_DEVICE_KEYS_WS_METHODS.status]: AuthAccessReadScope,
  [FORK_DEVICE_KEYS_WS_METHODS.subscribe]: AuthAccessReadScope,
} as const;

/** Metric/trace aggregate label for every `devices.*` method. */
export const FORK_DEVICE_KEYS_RPC_AGGREGATES = Object.fromEntries(
  Object.values(FORK_DEVICE_KEYS_WS_METHODS).map((method) => [method, "devices"]),
) as Record<
  (typeof FORK_DEVICE_KEYS_WS_METHODS)[keyof typeof FORK_DEVICE_KEYS_WS_METHODS],
  "devices"
>;
