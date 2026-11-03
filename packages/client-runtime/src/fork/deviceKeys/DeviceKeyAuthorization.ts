// fork: the only way a `t3x-device` environment gets a session (design Q10, 3.13). The default
// implementation refuses everything, so a runtime that forgot to provide a real one blocks the
// connection instead of falling back to the official relay or to a bearer token.
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type {
  AuthorizedRemoteEnvironment,
  AuthorizedRemoteHttpEnvironment,
} from "../../authorization/service.ts";
import type { ConnectionCatalogEntry } from "../../connection/catalog.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "../../connection/model.ts";

/** Failures here are always the device's own configuration, never the relay's. */
export const deviceConnectionBlocked = (
  detail: string,
  reason: ConnectionBlockedError["reason"] = "configuration",
) => new ConnectionBlockedError({ reason, detail, hop: "device", via: "direct" });

export const deviceConnectionTransient = (detail: string) =>
  new ConnectionTransientError({
    reason: "remote-unavailable",
    detail,
    hop: "device",
    via: "direct",
  });

export interface DeviceRoute {
  readonly expectedEnvironmentId: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface DeviceKeyAuthorizationShape {
  /** A session and socket URL for one route to the computer. Never falls back to anything. */
  readonly prepare: (
    input: DeviceRoute,
  ) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
  readonly authorizeHttp: (
    input: Pick<DeviceRoute, "expectedEnvironmentId" | "httpBaseUrl"> & {
      readonly rejectedAccessToken?: string;
    },
  ) => Effect.Effect<AuthorizedRemoteHttpEnvironment, ConnectionAttemptError>;
  /** Renews a live socket's session before it expires. Runs until interrupted. */
  readonly renew: (input: {
    readonly expectedEnvironmentId: string;
    readonly expiresAtEpochMs: number;
  }) => Effect.Effect<void, ConnectionBlockedError>;
  /** Drops the cached session of a removed computer. */
  readonly forget: (environmentId: string) => Effect.Effect<void>;
}

const unavailable = () =>
  deviceConnectionBlocked("Devices on your own server are not available in this app.");

export const blockedDeviceKeyAuthorization: DeviceKeyAuthorizationShape = {
  prepare: () => Effect.fail(unavailable()),
  authorizeHttp: () => Effect.fail(unavailable()),
  renew: () => Effect.fail(unavailable()),
  forget: () => Effect.void,
};

export const DeviceKeyAuthorization = Context.Reference<DeviceKeyAuthorizationShape>(
  "@t3tools/client-runtime/fork/deviceKeys/DeviceKeyAuthorization",
  { defaultValue: () => blockedDeviceKeyAuthorization },
);

const DEVICE_CONNECTION_PREFIX = "t3x-device:";

export const deviceConnectionId = (deviceId: string) => `${DEVICE_CONNECTION_PREFIX}${deviceId}`;

export interface ManagedDeviceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly deviceId: string;
  readonly url: string;
}

/** The one rule for "this saved environment belongs to the device sync"; nothing else persists an index. */
export const managedDeviceEnvironment = (
  entry: ConnectionCatalogEntry,
): ManagedDeviceEnvironment | null => {
  const profile = Option.getOrNull(entry.profile);
  if (
    entry.target._tag !== "BearerConnectionTarget" ||
    profile?._tag !== "BearerConnectionProfile" ||
    profile.authorization !== "t3x-device" ||
    profile.learned === true ||
    !profile.connectionId.startsWith(DEVICE_CONNECTION_PREFIX)
  ) {
    return null;
  }
  return {
    environmentId: entry.target.environmentId,
    deviceId: profile.connectionId.slice(DEVICE_CONNECTION_PREFIX.length),
    url: profile.httpBaseUrl,
  };
};

type ConnectionDirectory = SubscriptionRef.SubscriptionRef<
  ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
>;

/**
 * Which environments belong to the device sync, environment id to the device id it came from.
 * It reads the saved-connection directory on every call, so a restored or just registered
 * environment is found without any sync having run. The relay authorization refuses these ids as
 * a second line of defence even if a resolver stamp went missing.
 */
export interface DeviceEnvironmentIndexShape {
  readonly get: (environmentId: string) => string | undefined;
  /**
   * Points the index at the directory. The registry does this while it is built, before it hands
   * out the service that can start any connection, so no lookup precedes it.
   */
  readonly bind: (directory: ConnectionDirectory) => void;
}

export const makeDeviceEnvironmentIndex = (): DeviceEnvironmentIndexShape => {
  let directory: ConnectionDirectory | null = null;
  return {
    get: (environmentId) => {
      const entry =
        directory === null
          ? undefined
          : SubscriptionRef.getUnsafe(directory).get(environmentId as EnvironmentId);
      return entry === undefined ? undefined : managedDeviceEnvironment(entry)?.deviceId;
    },
    bind: (next) => {
      directory = next;
    },
  };
};

export const DeviceEnvironmentIndex = Context.Reference<DeviceEnvironmentIndexShape>(
  "@t3tools/client-runtime/fork/deviceKeys/DeviceEnvironmentIndex",
  { defaultValue: makeDeviceEnvironmentIndex },
);

/** The relay authorization calls this first: a device-managed environment never gets a relay token. */
export const refuseRelayForDeviceEnvironment = Effect.fnUntraced(function* (environmentId: string) {
  const index = yield* DeviceEnvironmentIndex;
  if (index.get(environmentId) !== undefined) {
    return yield* deviceConnectionBlocked(
      "This environment is managed by your own server, not T3 Connect.",
    );
  }
});
