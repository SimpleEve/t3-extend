// fork: the device-key capability as service methods (design 3.9). The WebSocket handlers, the
// `t3x devices` CLI and tests all call these; none of them carries logic of its own.
import {
  DEVICE_VISIBILITY_MAX_DEVICES,
  DeviceKeysError,
  type DeviceKind,
  type DeviceVisibility,
  type DevicesInviteResult,
  type DevicesRemoveResult,
  type DevicesRenameResult,
  type DevicesSignAssertionInput,
  type DevicesSignAssertionResult,
  type DevicesSnapshot,
  type DevicesStatus,
} from "@t3tools/contracts";
import { signAssertion } from "@t3tools/shared/forkDeviceKeys/assertion";
import { decodeInvite, redemptionOf } from "@t3tools/shared/forkDeviceKeys/invite";
import { normalizeVisibility } from "@t3tools/shared/forkDeviceKeys/visibility";
import { canonicalOrigin } from "@t3tools/shared/forkDeviceKeys/proof";
import { normalizeDeviceName } from "@t3tools/shared/forkDeviceKeys/subdomain";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import * as RegistryClient from "./RegistryClient.ts";

/** A computer asks its own server for at most this many passes a minute (design Q3). */
export const SIGN_ASSERTION_PER_MINUTE = 60;
const ASSERTION_LIFETIME_SECONDS = 60;

const fail = (reason: DeviceKeysError["reason"], message: string, registryCode?: string) =>
  new DeviceKeysError({
    reason,
    message,
    ...(registryCode === undefined ? {} : { registryCode }),
  });

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const INVITE_CODES = new Set(["invite_invalid", "invite_expired", "invite_used", "kind_mismatch"]);

/** The registry's reasons collapse to a few the UI can act on; the code rides along. */
const fromRegistryError = (error: RegistryClient.RegistryClientError): DeviceKeysError => {
  if (error.kind === "unreachable") {
    return fail("registry_unreachable", "The server could not be reached.");
  }
  if (error.kind === "rejected" && error.code !== undefined && INVITE_CODES.has(error.code)) {
    return fail("invite_invalid", "The invite was not accepted.", error.code);
  }
  if (error.kind === "rejected" && error.code === "rate_limited") {
    return fail("rate_limited", "The server asked to slow down.", error.code);
  }
  if (error.kind === "rejected" && error.code === "name_invalid") {
    return fail("invalid_input", "That device name is not allowed.", error.code);
  }
  return fail(
    "registry_rejected",
    "The server did not accept the request.",
    error.code ?? (error.kind === "protocol" ? "protocol" : undefined),
  );
};

export type DeviceKeysServiceError = DeviceKeysError;

export class DeviceKeysService extends Context.Service<
  DeviceKeysService,
  {
    readonly status: Effect.Effect<DevicesStatus>;
    readonly subscribe: Stream.Stream<DevicesSnapshot>;
    readonly refresh: Effect.Effect<DevicesStatus, DeviceKeysError>;
    readonly join: (input: {
      readonly invite: string;
      readonly name: string;
    }) => Effect.Effect<DevicesStatus, DeviceKeysError>;
    readonly leave: Effect.Effect<DevicesStatus, DeviceKeysError>;
    readonly invite: (kind: DeviceKind) => Effect.Effect<DevicesInviteResult, DeviceKeysError>;
    readonly cancelInvite: (id: string) => Effect.Effect<void, DeviceKeysError>;
    readonly remove: (deviceId: string) => Effect.Effect<DevicesRemoveResult, DeviceKeysError>;
    readonly rename: (
      deviceId: string,
      name: string,
    ) => Effect.Effect<DevicesRenameResult, DeviceKeysError>;
    /**
     * Who may see this computer and sign in to it. The local file and the sessions change first, so
     * the setting holds whatever the registry answers; the returned status says whether the registry has it.
     */
    readonly setVisibility: (
      input: DeviceVisibility,
    ) => Effect.Effect<DevicesStatus, DeviceKeysError>;
    /** The caller has already decided this is the local owner; the target comes from our own list. */
    readonly signAssertion: (
      input: DevicesSignAssertionInput,
    ) => Effect.Effect<DevicesSignAssertionResult, DeviceKeysError>;
  }
>()("t3/fork/deviceKeys/DeviceKeysService") {}

const make = Effect.gen(function* () {
  const directory = yield* DeviceDirectory.DeviceDirectory;
  const identity = yield* DeviceIdentity.DeviceIdentity;
  const registry = yield* RegistryClient.RegistryClient;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  // Join and leave change who this computer is; they never overlap each other.
  const membershipLock = yield* Semaphore.make(1);
  const signedAt = yield* Ref.make<ReadonlyArray<number>>([]);

  const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000));
  const storage = (cause: unknown) =>
    Effect.logWarning("Device key storage failed.", { cause }).pipe(
      Effect.as(fail("storage", "The device key could not be read or saved on this computer.")),
    );

  /** Membership plus the key, or `not_joined`. */
  const requireTarget = Effect.gen(function* () {
    const { membership } = yield* directory.state;
    const key = yield* identity.peek.pipe(Effect.catch((cause) => Effect.flip(storage(cause))));
    if (Option.isNone(membership) || Option.isNone(key)) {
      return yield* fail("not_joined", "This computer has not joined a server.");
    }
    return {
      membership: membership.value,
      target: {
        origin: membership.value.registryOrigin,
        registryId: membership.value.registryId,
        deviceId: membership.value.deviceId,
        privateKey: key.value.privateKey,
      },
      key: key.value,
    };
  });

  const resyncSoon = directory.sync.pipe(Effect.ignore);

  const join: DeviceKeysService["Service"]["join"] = Effect.fn("DeviceKeysService.join")(
    function* (input) {
      return yield* membershipLock.withPermits(1)(
        Effect.gen(function* () {
          if (Option.isSome((yield* directory.state).membership)) {
            return yield* fail("already_joined", "This computer is already part of a server.");
          }
          const invite = decodeInvite(input.invite.trim());
          const name = normalizeDeviceName(input.name);
          if (name === null)
            return yield* fail("invalid_input", "That device name is not allowed.");
          const now = yield* nowSeconds;
          if (invite === null || invite.expiresAt <= now || invite.kind === "phone") {
            return yield* fail("invite_invalid", "The invite is not valid for a computer.");
          }
          const origin = yield* Effect.try({
            try: () => canonicalOrigin(invite.origin),
            catch: () => fail("invite_invalid", "The invite points at an invalid address."),
          });
          const info = yield* registry.info(origin).pipe(Effect.mapError(fromRegistryError));
          if (info.registryId !== invite.registryId) {
            return yield* fail(
              "registry_rejected",
              "The server is not the one the invite was made for.",
              "registry_mismatch",
            );
          }
          const hadKey = Option.isSome(
            yield* identity.peek.pipe(Effect.catch((cause) => Effect.flip(storage(cause)))),
          );
          const key = yield* identity.getOrCreate.pipe(
            Effect.catch((cause) => Effect.flip(storage(cause))),
          );
          const environmentId = yield* environment.getEnvironmentId;
          return yield* Effect.gen(function* () {
            const joined = yield* registry
              .join({
                origin,
                invite: redemptionOf(invite),
                privateKey: key.privateKey,
                jwk: key.jwk,
                name,
                kind: "computer",
                environmentId,
              })
              .pipe(Effect.mapError(fromRegistryError));
            if (
              joined.deviceId !== key.id ||
              joined.registryId !== invite.registryId ||
              joined.subdomain === undefined ||
              joined.url === undefined
            ) {
              return yield* fail(
                "registry_rejected",
                "The server answered unexpectedly.",
                "protocol",
              );
            }
            yield* directory
              .adopt({
                v: 1,
                registryOrigin: origin,
                registryId: joined.registryId,
                deviceId: key.id,
                name: joined.name,
                subdomain: joined.subdomain,
                url: joined.url,
                environmentId,
                joinedAt: now,
              })
              .pipe(
                // Registered but not remembered: give the seat back so the invite is not wasted twice.
                Effect.tapError(() =>
                  registry
                    .removeDevice(
                      {
                        origin,
                        registryId: invite.registryId,
                        deviceId: key.id,
                        privateKey: key.privateKey,
                      },
                      key.id,
                    )
                    .pipe(Effect.ignore),
                ),
              );
            return yield* directory.sync;
          }).pipe(
            // A key that never became a membership is not worth keeping around.
            Effect.tapError(() => (hadKey ? Effect.void : identity.remove.pipe(Effect.ignore))),
          );
        }),
      );
    },
  );

  return DeviceKeysService.of({
    status: directory.status,
    subscribe: directory.changes,
    refresh: directory.sync,
    join,
    leave: membershipLock
      .withPermits(1)(
        Effect.gen(function* () {
          const { target, membership } = yield* requireTarget;
          yield* registry.removeDevice(target, membership.deviceId).pipe(
            // Already gone from the registry is the state the caller wanted.
            Effect.catch((error) =>
              error.kind === "rejected" && error.code === "device_unknown"
                ? Effect.void
                : Effect.fail(fromRegistryError(error)),
            ),
            Effect.asVoid,
          );
          yield* directory.clear("left");
          return yield* directory.status;
        }),
      )
      .pipe(Effect.withSpan("DeviceKeysService.leave")),
    invite: Effect.fn("DeviceKeysService.invite")(function* (kind) {
      const { target } = yield* requireTarget;
      const created = yield* registry
        .createInvite(target, kind)
        .pipe(Effect.mapError(fromRegistryError));
      return created;
    }),
    cancelInvite: Effect.fn("DeviceKeysService.cancelInvite")(function* (id) {
      const { target } = yield* requireTarget;
      yield* registry.cancelInvite(target, id).pipe(Effect.mapError(fromRegistryError));
    }),
    remove: Effect.fn("DeviceKeysService.remove")(function* (deviceId) {
      const { target, membership } = yield* requireTarget;
      if (deviceId === membership.deviceId) {
        return yield* fail("invalid_input", "Use leave to remove this computer.");
      }
      const before = (yield* directory.state).list;
      const removed = yield* registry
        .removeDevice(target, deviceId)
        .pipe(Effect.mapError(fromRegistryError));
      // Locally the sessions go now; other computers do it on their next sync.
      yield* resyncSoon;
      return {
        removedAt: removed.removedAt,
        rev: removed.rev,
        pendingComputers: Option.match(before, {
          onNone: () => [],
          onSome: (list) =>
            list.devices
              .filter(
                (device) =>
                  device.kind === "computer" &&
                  device.id !== membership.deviceId &&
                  device.id !== deviceId &&
                  (device.lastSyncAt ?? 0) < removed.removedAt,
              )
              .map((device) => ({ id: device.id, name: device.name })),
        }),
      };
    }),
    rename: Effect.fn("DeviceKeysService.rename")(function* (deviceId, name) {
      const { target } = yield* requireTarget;
      const normalized = normalizeDeviceName(name);
      if (normalized === null)
        return yield* fail("invalid_input", "That device name is not allowed.");
      const renamed = yield* registry
        .renameDevice(target, deviceId, normalized)
        .pipe(Effect.mapError(fromRegistryError));
      yield* resyncSoon;
      return renamed;
    }),
    setVisibility: Effect.fn("DeviceKeysService.setVisibility")(function* (input) {
      const { membership } = yield* requireTarget;
      if (
        input.deviceIds.length > DEVICE_VISIBILITY_MAX_DEVICES ||
        input.deviceIds.some((id) => !DEVICE_ID_PATTERN.test(id) || id === membership.deviceId)
      ) {
        return yield* fail("invalid_input", "Pick other devices from your server's list.");
      }
      yield* directory.setVisibility(normalizeVisibility(input));
      // Delivers the setting to the registry and settles its state; the local change stands either way.
      yield* resyncSoon;
      return yield* directory.status;
    }),
    signAssertion: Effect.fn("DeviceKeysService.signAssertion")(function* (input) {
      const { membership, key } = yield* requireTarget;
      const local = yield* directory.state;
      if (local.staleness === "expired" || local.staleness === "unavailable") {
        return yield* fail(
          "list_expired",
          "The device list is too old to sign passes. Sync with the server first.",
        );
      }
      const now = local.nowSeconds;
      const allowed = yield* Ref.modify(signedAt, (times) => {
        const recent = times.filter((at) => at > now - 60);
        return recent.length >= SIGN_ASSERTION_PER_MINUTE
          ? ([false, recent] as const)
          : ([true, [...recent, now]] as const);
      });
      if (!allowed) return yield* fail("rate_limited", "Too many passes were requested.");
      const target = Option.getOrUndefined(local.list)?.devices.find(
        (device) =>
          device.kind === "computer" &&
          device.id !== membership.deviceId &&
          device.environmentId === input.audienceEnvironmentId,
      );
      if (target === undefined) {
        return yield* fail("unknown_audience", "That computer is not part of this server.");
      }
      yield* Effect.logInfo("Signing a device pass.", {
        deviceId: membership.deviceId,
        audienceEnvironmentId: input.audienceEnvironmentId,
        jkt: input.dpopThumbprint.slice(0, 8),
      });
      return signAssertion({
        privateKey: key.privateKey,
        deviceId: membership.deviceId,
        audienceEnvironmentId: input.audienceEnvironmentId,
        registryId: membership.registryId,
        dpopThumbprint: input.dpopThumbprint,
        iat: now,
        lifetimeSeconds: ASSERTION_LIFETIME_SECONDS,
      });
    }),
  });
});

export const layer = Layer.effect(DeviceKeysService, make);
