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

/** This device's own wait for something local, which the diagnosis words as waiting, not as failing. */
const deviceConnectionPending = (detail: string) =>
  new ConnectionTransientError({
    reason: "remote-unavailable",
    detail,
    hop: "device",
    via: "direct",
    failureCause: "device_list_pending",
  });

/** The server's computer list has not arrived yet, as after a restart; it will, so the connection retries. */
export const deviceListNotReady = () =>
  deviceConnectionPending("Your server's device list is not available yet.");

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
 * It reads the saved-connection directories on every call, so a restored or just registered
 * environment is found without any sync having run. The relay authorization refuses these ids as
 * a second line of defence even if a resolver stamp went missing.
 */
export interface DeviceEnvironmentIndexShape {
  readonly get: (environmentId: string) => string | undefined;
  /** Adds a directory to look in, and returns the function that takes it out again. */
  readonly bind: (directory: ConnectionDirectory) => () => void;
  /** True while the index was made fail-closed and no directory is bound. */
  readonly notReady: () => boolean;
}

/**
 * `failClosedUntilBound`: a runtime that has the device feature turns this on, so that until a
 * registry has bound its directory the relay authorization refuses every environment instead of
 * letting a device environment through for want of a directory to recognise it in.
 */
export const makeDeviceEnvironmentIndex = (options?: {
  readonly failClosedUntilBound?: boolean;
}): DeviceEnvironmentIndexShape => {
  const directories: Array<ConnectionDirectory> = [];
  return {
    get: (environmentId) => {
      for (const directory of directories) {
        const entry = SubscriptionRef.getUnsafe(directory).get(environmentId as EnvironmentId);
        const managed = entry === undefined ? null : managedDeviceEnvironment(entry);
        if (managed !== null) return managed.deviceId;
      }
      return undefined;
    },
    bind: (directory) => {
      directories.push(directory);
      return () => {
        const at = directories.indexOf(directory);
        if (at >= 0) directories.splice(at, 1);
      };
    },
    notReady: () => options?.failClosedUntilBound === true && directories.length === 0,
  };
};

export const DeviceEnvironmentIndex = Context.Reference<DeviceEnvironmentIndexShape>(
  "@t3tools/client-runtime/fork/deviceKeys/DeviceEnvironmentIndex",
  { defaultValue: makeDeviceEnvironmentIndex },
);

/**
 * A registry binds its directory for as long as it lives; the registry's scope takes it out again,
 * so a second registry in the same runtime adds to the first rather than replacing it.
 */
export const bindDeviceEnvironmentIndex = Effect.fnUntraced(function* (
  directory: ConnectionDirectory,
) {
  const index = yield* DeviceEnvironmentIndex;
  yield* Effect.acquireRelease(
    Effect.sync(() => index.bind(directory)),
    (unbind) => Effect.sync(unbind),
  );
});

/** The relay authorization calls this first: a device-managed environment never gets a relay token. */
export const refuseRelayForDeviceEnvironment = Effect.fnUntraced(function* (environmentId: string) {
  const index = yield* DeviceEnvironmentIndex;
  if (index.notReady()) {
    // Transient: the registry binds as it is built, so this ends by itself, and nothing falls back to a relay.
    return yield* deviceConnectionPending("The saved connections are not ready yet.");
  }
  if (index.get(environmentId) !== undefined) {
    return yield* deviceConnectionBlocked(
      "This environment is managed by your own server, not T3 Connect.",
    );
  }
});
