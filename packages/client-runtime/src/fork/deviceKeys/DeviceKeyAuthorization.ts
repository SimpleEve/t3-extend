// fork: the only way a `t3x-device` environment gets a session (design Q10, 3.13). The default
// implementation refuses everything, so a runtime that forgot to provide a real one blocks the
// connection instead of falling back to the official relay or to a bearer token.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type {
  AuthorizedRemoteEnvironment,
  AuthorizedRemoteHttpEnvironment,
} from "../../authorization/service.ts";
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

/**
 * Which environments the sync manages, environment id to the device id it came from. A second
 * line of defence: the relay authorization refuses these ids even if a resolver stamp went missing.
 */
export interface DeviceEnvironmentIndexShape {
  readonly get: (environmentId: string) => string | undefined;
  readonly replace: (entries: ReadonlyMap<string, string>) => void;
}

export const makeDeviceEnvironmentIndex = (): DeviceEnvironmentIndexShape => {
  let current: ReadonlyMap<string, string> = new Map();
  return {
    get: (environmentId) => current.get(environmentId),
    replace: (entries) => {
      current = new Map(entries);
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
