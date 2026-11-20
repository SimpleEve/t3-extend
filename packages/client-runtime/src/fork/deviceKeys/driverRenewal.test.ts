import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RemoteEnvironmentAuthorization from "../../authorization/service.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../../connection/catalog.ts";
import * as ConnectionDriver from "../../connection/driver.ts";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../../connection/model.ts";
import * as ConnectionResolver from "../../connection/resolver.ts";
import * as RpcHttp from "../../rpc/http.ts";
import * as RpcSession from "../../rpc/session.ts";
import { DeviceKeyAuthorization, blockedDeviceKeyAuthorization } from "./DeviceKeyAuthorization.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-mac");

const deviceEntry = (): ConnectionCatalogEntry => {
  const target = new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Mac",
    connectionId: "t3x-device:device-1",
  });
  return {
    target,
    enabled: true,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: target.connectionId,
        environmentId: ENVIRONMENT_ID,
        label: "Mac",
        httpBaseUrl: "https://mac.t3.example.test/",
        wsBaseUrl: "wss://mac.t3.example.test/",
        authorization: "t3x-device",
      }),
    ),
  };
};

const prepared = (extra: Partial<PreparedConnection>): PreparedConnection => ({
  environmentId: ENVIRONMENT_ID,
  label: "Mac",
  httpBaseUrl: "https://mac.t3.example.test/",
  socketUrl: "wss://mac.t3.example.test/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "session", expiresAtEpochMs: 123_000 },
  target: new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Mac" }),
  ...extra,
});

const connectWith = Effect.fn("connectWith")(function* (
  preparedConnection: PreparedConnection,
  entry: ConnectionCatalogEntry,
) {
  const renewed = yield* Deferred.make<string>();
  const relayRenewals: Array<string> = [];
  const session = {
    ready: Effect.void,
    closed: Effect.never,
  } as unknown as RpcSession.RpcSession;
  const layer = ConnectionDriver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          ConnectionResolver.ConnectionResolver,
          ConnectionResolver.ConnectionResolver.of({
            prepare: () => Effect.succeed(preparedConnection),
            prepareForUpdate: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(
          RpcSession.RpcSessionFactory,
          RpcSession.RpcSessionFactory.of({ connect: () => Effect.succeed(session) }),
        ),
        Layer.succeed(
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
            authorizeBearer: () => Effect.die("unused"),
            authorizeDpop: () => Effect.die("unused"),
            authorizeDpopHttp: () => Effect.die("unused"),
            authorizeDirectDpop: () => Effect.die("unused"),
            authorizeDirectDpopHttp: () => Effect.die("unused"),
            rememberCheckedDescriptor: () => Effect.void,
            renewDpopBeforeExpiry: (input) =>
              Effect.sync(() => void relayRenewals.push(input.expectedEnvironmentId)).pipe(
                Effect.andThen(Deferred.succeed(renewed, "relay")),
                Effect.asVoid,
              ),
          }),
        ),
        RpcHttp.layerRemoteHttpClient(() => Promise.reject(new Error("no network"))),
      ),
    ),
  );
  const deviceRenewals: Array<{ expectedEnvironmentId: string; expiresAtEpochMs: number }> = [];
  // The renewal is a fiber in the connect scope, so the scope stays open until it has run.
  const who = yield* Effect.gen(function* () {
    const driver = yield* ConnectionDriver.ConnectionDriver;
    yield* driver.connect(entry, () => Effect.void);
    return yield* Deferred.await(renewed);
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(DeviceKeyAuthorization, {
      ...blockedDeviceKeyAuthorization,
      renew: (input) =>
        Effect.sync(() => void deviceRenewals.push(input)).pipe(
          Effect.andThen(Deferred.succeed(renewed, "device")),
          Effect.asVoid,
        ),
    }),
    Effect.scoped,
  );
  return { who, deviceRenewals, relayRenewals };
});

describe("connection driver renewal", () => {
  it.effect("renews a device session through the device authorization and not the relay's", () =>
    Effect.gen(function* () {
      const result = yield* connectWith(prepared({ authorizer: "t3x-device" }), deviceEntry());
      expect(result.who).toBe("device");
      expect(result.deviceRenewals).toEqual([
        { expectedEnvironmentId: ENVIRONMENT_ID, expiresAtEpochMs: 123_000 },
      ]);
      expect(result.relayRenewals).toEqual([]);
    }),
  );

  it.effect("keeps renewing an unstamped DPoP session through the relay, as before", () =>
    Effect.gen(function* () {
      const result = yield* connectWith(prepared({}), deviceEntry());
      expect(result.who).toBe("relay");
      expect(result.deviceRenewals).toEqual([]);
    }),
  );
});
