// fork: this computer's view of the device list, and the one lock that decides who may get a
// session (design Q2 "撤销链" / Q8 / 3.8). The registry's list is the truth; this holds the last copy,
// says how old it is, and revokes the sessions of devices that are no longer on it.
import {
  DeviceKeysError,
  T3X_DEVICE_SUBJECT_PREFIX,
  type DeviceListEntry,
  type DeviceListStaleness,
  type DevicesSnapshot,
  type DevicesStatus,
  type DeviceTunnelStatus,
  RegistryDevice,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import * as RegistryClient from "./RegistryClient.ts";

export const MEMBERSHIP_SECRET = "fork-device-membership";
export const LIST_SECRET = "fork-device-list";
const SYNC_INTERVAL = Duration.seconds(60);
/** Unknown device ids ask for a refresh; at most one is started per this long, whichever ids they are. */
const UNKNOWN_DEVICE_REFRESH_GAP_MILLIS = 10_000;
/** Past this the settings page warns. */
const WARN_AFTER_SECONDS = 24 * 60 * 60;
/** Past this no new device passes are accepted (a sync success restores them). */
const EXPIRE_AFTER_SECONDS = 7 * 24 * 60 * 60;

export const Membership = Schema.Struct({
  v: Schema.Literal(1),
  registryOrigin: Schema.String,
  registryId: Schema.String,
  deviceId: Schema.String,
  name: Schema.String,
  subdomain: Schema.String,
  url: Schema.String,
  environmentId: Schema.String,
  joinedAt: Schema.Number,
});
export type Membership = typeof Membership.Type;

const StoredList = Schema.Struct({
  v: Schema.Literal(1),
  rev: Schema.Number,
  fetchedAt: Schema.Number,
  registryId: Schema.String,
  devices: Schema.Array(RegistryDevice),
});
export type StoredList = typeof StoredList.Type;

const decodeMembership = Schema.decodeUnknownOption(Schema.fromJsonString(Membership));
const encodeMembership = Schema.encodeSync(Schema.fromJsonString(Membership));
const decodeStoredList = Schema.decodeUnknownOption(Schema.fromJsonString(StoredList));
const encodeStoredList = Schema.encodeSync(Schema.fromJsonString(StoredList));

type LocalState = {
  readonly membership: Option.Option<Membership>;
  readonly list: Option.Option<StoredList>;
  /** In memory only: the registry said this computer is no longer a member. */
  readonly removed: boolean;
};

/** `now < fetchedAt` (the clock went back past the last sync) counts as stale, never as fresh. */
const stalenessOf = (list: Option.Option<StoredList>, nowSeconds: number): DeviceListStaleness => {
  if (Option.isNone(list)) return "unavailable";
  const age = nowSeconds - list.value.fetchedAt;
  if (age < 0) return "warn";
  if (age <= WARN_AFTER_SECONDS) return "fresh";
  return age <= EXPIRE_AFTER_SECONDS ? "warn" : "expired";
};

/** `t3x-device:<kind>:<id>` → id. */
const deviceIdOfSubject = (subject: string): string | null =>
  subject.startsWith(T3X_DEVICE_SUBJECT_PREFIX) ? (subject.split(":").at(-1) ?? null) : null;

export class DeviceDirectory extends Context.Service<
  DeviceDirectory,
  {
    readonly state: Effect.Effect<{
      readonly membership: Option.Option<Membership>;
      readonly list: Option.Option<StoredList>;
      readonly staleness: DeviceListStaleness;
      readonly nowSeconds: number;
    }>;
    readonly status: Effect.Effect<DevicesStatus>;
    /** The current snapshot, then every change. Subscribed before the first read, so none is lost. */
    readonly changes: Stream.Stream<DevicesSnapshot>;
    /** One pull from the registry, then the reconcile. The 60-second tick and `devices.refresh` run it. */
    readonly sync: Effect.Effect<DevicesStatus, DeviceKeysError>;
    /**
     * A pass named a device this list does not have: sync in the background, without waiting, so the
     * next try may find it. One at a time, and at most one per 10 seconds; nothing when not joined.
     */
    readonly refreshSoon: Effect.Effect<void>;
    /** Syncs immediately, then every 60 seconds, forever. The layer forks it once the server is active. */
    readonly syncLoop: Effect.Effect<unknown>;
    /** The only way in or out of membership besides a sync that finds this computer removed. */
    readonly adopt: (membership: Membership) => Effect.Effect<void, DeviceKeysError>;
    readonly clear: (reason: "left" | "removed") => Effect.Effect<void, DeviceKeysError>;
    /** Serializes with reconcile. Everything that issues a session runs inside it. */
    readonly withGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly tunnelOrigin: Effect.Effect<Option.Option<string>>;
    readonly setTunnelStatus: (status: DeviceTunnelStatus) => Effect.Effect<void>;
    /** Re-reads the list file written by the CLI or another process into memory. */
    readonly reload: Effect.Effect<void>;
  }
>()("t3/fork/deviceKeys/DeviceDirectory") {}

/** The cause goes to the log; the caller (and the wire) only learn that saving failed. */
const storageFailure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.tapError((cause) => Effect.logWarning("Device state could not be saved.", { cause })),
    Effect.mapError(
      () =>
        new DeviceKeysError({
          reason: "storage",
          message: "The device list could not be saved on this computer.",
        }),
    ),
  );

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* DeviceIdentity.DeviceIdentity;
  const registry = yield* RegistryClient.RegistryClient;
  const sessions = yield* SessionStore.SessionStore;
  const gate = yield* Semaphore.make(1);
  const layerScope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<DevicesSnapshot>();
  const tunnel = yield* Ref.make<DeviceTunnelStatus>({ status: "disabled", lastError: null });

  const readMembership = Effect.suspend(() => secrets.get(MEMBERSHIP_SECRET)).pipe(
    Effect.map((bytes) =>
      Option.flatMap(bytes, (value) => decodeMembership(new TextDecoder().decode(value))),
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not read the device membership; treating it as absent.", {
        error: error.message,
      }).pipe(Effect.as(Option.none<Membership>())),
    ),
  );
  const readList = (membership: Option.Option<Membership>) =>
    secrets.get(LIST_SECRET).pipe(
      Effect.map((bytes) =>
        Option.flatMap(bytes, (value) => decodeStoredList(new TextDecoder().decode(value))).pipe(
          // A list from another registry must not be trusted for this membership.
          Option.filter((list) =>
            Option.exists(membership, (current) => current.registryId === list.registryId),
          ),
        ),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not read the device list; treating it as absent.", {
          error: error.message,
        }).pipe(Effect.as(Option.none<StoredList>())),
      ),
    );

  const initialMembership = yield* readMembership;
  const state = yield* Ref.make<LocalState>({
    membership: initialMembership,
    list: yield* readList(initialMembership),
    removed: false,
  });

  const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000));

  const toStatus = (
    local: LocalState,
    now: number,
    tunnelStatus: DeviceTunnelStatus,
  ): DevicesStatus => {
    const membership = Option.getOrUndefined(local.membership);
    return {
      state: membership !== undefined ? "joined" : local.removed ? "removed" : "not_joined",
      registryOrigin: membership?.registryOrigin ?? null,
      registryHost: membership === undefined ? null : new URL(membership.registryOrigin).host,
      deviceId: membership?.deviceId ?? null,
      name: membership?.name ?? null,
      url: membership?.url ?? null,
      tunnel: tunnelStatus,
      fetchedAt: Option.match(local.list, { onNone: () => null, onSome: (list) => list.fetchedAt }),
      staleness: stalenessOf(local.list, now),
    };
  };

  const status = Effect.gen(function* () {
    return toStatus(yield* Ref.get(state), yield* nowSeconds, yield* Ref.get(tunnel));
  });

  const toEntry = (device: RegistryDevice, selfId: string | undefined): DeviceListEntry => ({
    id: device.id,
    name: device.name,
    kind: device.kind,
    ...(device.subdomain === undefined ? {} : { subdomain: device.subdomain }),
    ...(device.url === undefined ? {} : { url: device.url }),
    ...(device.online === undefined ? {} : { online: device.online }),
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    self: device.id === selfId,
  });

  const snapshot = Effect.gen(function* () {
    const local = yield* Ref.get(state);
    const selfId = Option.getOrUndefined(local.membership)?.deviceId;
    return {
      status: toStatus(local, yield* nowSeconds, yield* Ref.get(tunnel)),
      rev: Option.match(local.list, { onNone: () => null, onSome: (list) => list.rev }),
      devices: Option.match(local.list, {
        onNone: () => [],
        onSome: (list) => list.devices.map((device) => toEntry(device, selfId)),
      }),
    } satisfies DevicesSnapshot;
  });
  const publish = Effect.flatMap(snapshot, (value) => PubSub.publish(changes, value));

  const persistList = (list: StoredList) =>
    secrets.set(LIST_SECRET, new TextEncoder().encode(encodeStoredList(list))).pipe(storageFailure);

  /**
   * Revokes the sessions of every device that is not in `keep`. Idempotent, so every sync runs it.
   * Then closes the sockets of sessions that another process (`devices remove` in the CLI) revoked
   * already: `listActive` no longer returns those rows, and this server never saw the write.
   */
  const reconcile = (keep: ReadonlySet<string>) =>
    sessions.listActive().pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows.filter((row) => {
            const id = deviceIdOfSubject(row.subject);
            return id !== null && !keep.has(id);
          }),
          (row) => sessions.revoke(row.sessionId),
          { discard: true },
        ),
      ),
      Effect.andThen(sessions.announceRevoked()),
      storageFailure,
      Effect.withSpan("DeviceDirectory.reconcile"),
    );

  /** Must run inside the gate. */
  const clearLocked = Effect.fn("DeviceDirectory.clear")(function* (reason: "left" | "removed") {
    yield* Effect.all(
      [
        secrets.remove(MEMBERSHIP_SECRET).pipe(storageFailure),
        secrets.remove(LIST_SECRET).pipe(storageFailure),
        identity.remove.pipe(storageFailure),
      ],
      { discard: true },
    );
    yield* Ref.set(state, {
      membership: Option.none(),
      list: Option.none(),
      removed: reason === "removed",
    });
    yield* reconcile(new Set());
    yield* publish;
  });

  const reload = Effect.gen(function* () {
    const membership = yield* readMembership;
    const current = yield* Ref.get(state);
    const sameDevice =
      Option.isSome(membership) === Option.isSome(current.membership) &&
      Option.getOrUndefined(membership)?.deviceId ===
        Option.getOrUndefined(current.membership)?.deviceId &&
      Option.getOrUndefined(membership)?.registryId ===
        Option.getOrUndefined(current.membership)?.registryId;
    if (sameDevice) return;
    // Another process (the CLI) joined or left: take its membership and whatever list it left.
    yield* Ref.set(state, {
      membership,
      list: yield* readList(membership),
      removed: Option.isNone(membership) && current.removed,
    });
    yield* publish;
  });

  const sync = Effect.fn("DeviceDirectory.sync")(function* () {
    yield* reload;
    const local = yield* Ref.get(state);
    const membership = Option.getOrUndefined(local.membership);
    if (membership === undefined) return yield* status;
    const key = yield* identity.peek.pipe(storageFailure);
    if (Option.isNone(key)) return yield* status;
    const target = {
      origin: membership.registryOrigin,
      registryId: membership.registryId,
      deviceId: membership.deviceId,
      privateKey: key.value.privateKey,
    };
    const fetched = yield* registry.listDevices(target).pipe(Effect.result);
    if (fetched._tag === "Failure") {
      const error = fetched.failure;
      if (error.kind === "rejected" && error.code === "device_unknown") {
        yield* gate.withPermits(1)(clearLocked("removed"));
      } else {
        yield* Effect.logWarning("Device list sync failed; keeping the last list.", {
          kind: error.kind,
          status: error.status,
          code: error.code,
        });
      }
      return yield* status;
    }
    yield* gate.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* nowSeconds;
        const before = yield* Ref.get(state);
        if (Option.isNone(before.membership)) return;
        const body = fetched.success;
        const next: StoredList = {
          v: 1,
          rev: body.rev,
          fetchedAt: now,
          registryId: body.registryId,
          devices: body.devices,
        };
        if (!next.devices.some((device) => device.id === membership.deviceId)) {
          // The registry answered with a list that does not contain this computer.
          yield* clearLocked("removed");
          return;
        }
        yield* persistList(next);
        yield* Ref.update(state, (current) => ({ ...current, list: Option.some(next) }));
        yield* reconcile(new Set(next.devices.map((device) => device.id)));
        // Every successful answer moves `fetchedAt`, which clients show as the last sync.
        yield* publish;
      }),
    );
    return yield* status;
  });

  const unknownDeviceRefresh = yield* Ref.make<{
    readonly running: boolean;
    readonly startedAt: number | undefined;
  }>({ running: false, startedAt: undefined });
  const refreshSoon = Effect.gen(function* () {
    if (Option.isNone((yield* Ref.get(state)).membership)) return;
    const now = yield* Clock.currentTimeMillis;
    const start = yield* Ref.modify(unknownDeviceRefresh, (current) =>
      current.running ||
      (current.startedAt !== undefined &&
        now - current.startedAt < UNKNOWN_DEVICE_REFRESH_GAP_MILLIS)
        ? ([false, current] as const)
        : ([true, { running: true, startedAt: now }] as const),
    );
    if (!start) return;
    // Not in the request's fiber: it ends with the response, and the refresh must not.
    yield* sync().pipe(
      Effect.catch((error) =>
        Effect.logWarning("Device list refresh after an unknown device failed.", {
          error: error.message,
        }),
      ),
      Effect.ensuring(
        Ref.update(unknownDeviceRefresh, (current) => ({ ...current, running: false })),
      ),
      Effect.forkIn(layerScope),
    );
  });

  const syncLoop = sync().pipe(
    Effect.catch((error) =>
      Effect.logWarning("Device list sync failed.", { error: error.message }),
    ),
    Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
  );

  return DeviceDirectory.of({
    state: Effect.gen(function* () {
      const local = yield* Ref.get(state);
      const now = yield* nowSeconds;
      return {
        membership: local.membership,
        list: local.list,
        staleness: stalenessOf(local.list, now),
        nowSeconds: now,
      };
    }),
    status,
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const first = yield* snapshot;
        return Stream.concat(Stream.make(first), Stream.fromSubscription(subscription));
      }),
    ),
    sync: sync(),
    refreshSoon,
    syncLoop,
    adopt: Effect.fn("DeviceDirectory.adopt")(function* (membership) {
      yield* gate.withPermits(1)(
        Effect.gen(function* () {
          yield* secrets
            .set(MEMBERSHIP_SECRET, new TextEncoder().encode(encodeMembership(membership)))
            .pipe(storageFailure);
          yield* secrets.remove(LIST_SECRET).pipe(storageFailure);
          yield* Ref.set(state, {
            membership: Option.some(membership),
            list: Option.none(),
            removed: false,
          });
          yield* publish;
        }),
      );
    }),
    clear: Effect.fn("DeviceDirectory.clearGated")((reason: "left" | "removed") =>
      gate.withPermits(1)(clearLocked(reason)),
    ),
    withGate: gate.withPermits(1),
    tunnelOrigin: Effect.map(Ref.get(state), (local) =>
      Option.map(local.membership, (membership) => membership.url),
    ),
    setTunnelStatus: Effect.fn("DeviceDirectory.setTunnelStatus")((next: DeviceTunnelStatus) =>
      Ref.set(tunnel, next).pipe(Effect.andThen(publish)),
    ),
    reload,
  });
});

export const layer = Layer.effect(DeviceDirectory, make);
