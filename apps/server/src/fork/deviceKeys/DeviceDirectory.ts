// fork: this computer's view of the device list, and the one lock that decides who may get a
// session (design Q2 "撤销链" / Q8 / 3.8). The registry's list is the truth; this holds the last copy,
// says how old it is, and revokes the sessions of devices that are no longer on it.
import {
  DeviceKeysError,
  T3X_DEVICE_SUBJECT_PREFIX,
  type DeviceListEntry,
  type DeviceListStaleness,
  type DeviceVisibilityRegistryState,
  type DevicesSnapshot,
  type DevicesStatus,
  type DeviceTunnelStatus,
  DeviceVisibility,
  RegistryDevice,
  RegistryHiddenPeer,
} from "@t3tools/contracts";
import {
  DEFAULT_VISIBILITY,
  isVisibleTo,
  normalizeVisibility,
  sameVisibility,
} from "@t3tools/shared/forkDeviceKeys/visibility";
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
/** This computer's own choice of who may see it. Read from the file on every pass, so the CLI's change counts at once. */
export const VISIBILITY_SECRET = "fork-device-visibility";
/** What the registry last said about this computer's setting, kept so the CLI's next process can show it. */
const VISIBILITY_SYNC_SECRET = "fork-device-visibility-sync";
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
  hiddenPeers: Schema.optionalKey(Schema.Array(RegistryHiddenPeer)),
});
export type StoredList = typeof StoredList.Type;

const StoredVisibility = Schema.Struct({
  v: Schema.Literal(1),
  visibility: DeviceVisibility,
});
const StoredVisibilitySync = Schema.Struct({
  v: Schema.Literal(1),
  registry: Schema.Literals(["synced", "pending", "unsupported"]),
  /** The setting the registry state is about. */
  visibility: DeviceVisibility,
});
const decodeStoredVisibilitySync = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredVisibilitySync),
);
const encodeStoredVisibilitySync = Schema.encodeSync(Schema.fromJsonString(StoredVisibilitySync));
const decodeStoredVisibility = Schema.decodeUnknownOption(Schema.fromJsonString(StoredVisibility));
const encodeStoredVisibility = Schema.encodeSync(Schema.fromJsonString(StoredVisibility));

/** Everything this computer can check a pass from: the listed devices and the computers hidden from it. */
export const findSigner = (list: StoredList, deviceId: string) =>
  list.devices.find((device) => device.id === deviceId) ??
  list.hiddenPeers?.find((peer) => peer.id === deviceId);

const everyKnownId = (list: StoredList): ReadonlySet<string> =>
  new Set([...list.devices.map((d) => d.id), ...(list.hiddenPeers ?? []).map((p) => p.id)]);

const decodeMembership = Schema.decodeUnknownOption(Schema.fromJsonString(Membership));
const encodeMembership = Schema.encodeSync(Schema.fromJsonString(Membership));
const decodeStoredList = Schema.decodeUnknownOption(Schema.fromJsonString(StoredList));
const encodeStoredList = Schema.encodeSync(Schema.fromJsonString(StoredList));

type LocalState = {
  readonly membership: Option.Option<Membership>;
  readonly list: Option.Option<StoredList>;
  /** In memory only: the registry said this computer is no longer a member. */
  readonly removed: boolean;
  /** The last value read from the file; `visibility` below re-reads it before anything decides on it. */
  readonly visibility: DeviceVisibility;
  /** The file could not be read; `visibility` is then the last value that could. Never pushed, never shown as the choice. */
  readonly visibilityUnreadable: boolean;
  /** In memory only: whether the registry holds `visibility`. */
  readonly visibilityRegistry: DeviceVisibilityRegistryState;
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
    /**
     * Who may see this computer and sign in to it, read from the saved file. A file that is there but
     * cannot be read hides this computer from everyone: a pass is never accepted on a guess.
     */
    readonly visibility: Effect.Effect<DeviceVisibility>;
    /**
     * Saves the setting and revokes the sessions of the devices it now excludes, in one step under the
     * gate. Telling the registry is the caller's next move (`sync` does it).
     */
    readonly setVisibility: (visibility: DeviceVisibility) => Effect.Effect<void, DeviceKeysError>;
  }
>()("t3/fork/deviceKeys/DeviceDirectory") {}

/** A setting that keeps changing while it is delivered stays pending after this many tries; the next sync goes on. */
const MAX_DELIVERIES = 3;

const HIDDEN_FROM_ALL: DeviceVisibility = { mode: "hidden_from_all", deviceIds: [] };

type VisibilityRead =
  | { readonly readable: true; readonly visibility: DeviceVisibility }
  | { readonly readable: false };

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

  /** A file that is there but cannot be read is `readable: false`: nothing may be guessed from it. */
  const readVisibilityFile = Effect.suspend(() => secrets.get(VISIBILITY_SECRET)).pipe(
    Effect.map((bytes): VisibilityRead =>
      Option.match(bytes, {
        onNone: () => ({ readable: true, visibility: DEFAULT_VISIBILITY }),
        onSome: (value) =>
          Option.match(decodeStoredVisibility(new TextDecoder().decode(value)), {
            onNone: () => ({ readable: false }),
            onSome: (stored) => ({
              readable: true,
              visibility: normalizeVisibility(stored.visibility),
            }),
          }),
      }),
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not read the device visibility; hiding this computer.", {
        error: error.message,
      }).pipe(Effect.as<VisibilityRead>({ readable: false })),
    ),
  );
  /** What a pass is judged by: an unreadable file hides this computer from everyone. */
  const readVisibility = readVisibilityFile.pipe(
    Effect.map((read) => (read.readable ? read.visibility : HIDDEN_FROM_ALL)),
  );

  /** What the registry last said about `visibility`; `fallback` when nothing was saved. */
  const readRegistryState = (
    visibility: DeviceVisibility,
    fallback: DeviceVisibilityRegistryState,
  ) =>
    Effect.suspend(() => secrets.get(VISIBILITY_SYNC_SECRET)).pipe(
      Effect.map((bytes): DeviceVisibilityRegistryState => {
        const stored = Option.flatMap(bytes, (value) =>
          decodeStoredVisibilitySync(new TextDecoder().decode(value)),
        );
        if (Option.isNone(stored)) return fallback;
        // Being too old to hold the setting is about the registry; a delivered value is only about that value.
        if (stored.value.registry === "unsupported") return "unsupported";
        return sameVisibility(stored.value.visibility, visibility)
          ? stored.value.registry
          : "pending";
      }),
      Effect.catch(() => Effect.succeed(fallback)),
    );
  const writeRegistryState = (
    registry: DeviceVisibilityRegistryState,
    visibility: DeviceVisibility,
  ) =>
    registry === "unknown"
      ? Effect.void
      : secrets
          .set(
            VISIBILITY_SYNC_SECRET,
            new TextEncoder().encode(encodeStoredVisibilitySync({ v: 1, registry, visibility })),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not save whether the server has the visibility setting.", {
                error: error.message,
              }),
            ),
          );

  const initialMembership = yield* readMembership;
  const initialRead = yield* readVisibilityFile;
  const initialVisibility = initialRead.readable ? initialRead.visibility : HIDDEN_FROM_ALL;
  const state = yield* Ref.make<LocalState>({
    membership: initialMembership,
    list: yield* readList(initialMembership),
    removed: false,
    visibility: initialVisibility,
    visibilityUnreadable: !initialRead.readable,
    visibilityRegistry: initialRead.readable
      ? yield* readRegistryState(initialVisibility, "unknown")
      : "unknown",
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
      ...(membership === undefined
        ? {}
        : {
            visibility: {
              mode: local.visibility.mode,
              deviceIds: local.visibility.deviceIds,
              registry: local.visibilityRegistry,
              ...(local.visibilityUnreadable ? { unreadable: true } : {}),
            },
          }),
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
   * Revokes the sessions of every device that is not in `keep` (`null` keeps everyone) or that
   * `visibility` hides this computer from. Idempotent, so every sync runs it.
   */
  const reconcile = (keep: ReadonlySet<string> | null, visibility: DeviceVisibility) =>
    sessions.listActive().pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows.filter((row) => {
            const id = deviceIdOfSubject(row.subject);
            return (
              id !== null && ((keep !== null && !keep.has(id)) || !isVisibleTo(visibility, id))
            );
          }),
          (row) => sessions.revoke(row.sessionId),
          { discard: true },
        ),
      ),
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
        secrets.remove(VISIBILITY_SECRET).pipe(storageFailure),
        secrets.remove(VISIBILITY_SYNC_SECRET).pipe(storageFailure),
      ],
      { discard: true },
    );
    yield* Ref.set(state, {
      membership: Option.none(),
      list: Option.none(),
      removed: reason === "removed",
      visibility: DEFAULT_VISIBILITY,
      visibilityUnreadable: false,
      visibilityRegistry: "unknown",
    });
    yield* reconcile(new Set(), DEFAULT_VISIBILITY);
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
    if (sameDevice) {
      // The CLI may have changed the setting; the file is the truth.
      const read = yield* readVisibilityFile;
      if (!read.readable) {
        // Keep the last value that could be read: the guess is for refusing passes, not for showing or delivering.
        if (!current.visibilityUnreadable) {
          yield* Ref.update(state, (latest) => ({ ...latest, visibilityUnreadable: true }));
          yield* publish;
        }
        return;
      }
      const changed = !sameVisibility(read.visibility, current.visibility);
      if (changed || current.visibilityUnreadable) {
        const visibilityRegistry = changed
          ? yield* readRegistryState(read.visibility, "pending")
          : current.visibilityRegistry;
        yield* Ref.update(state, (latest) => ({
          ...latest,
          visibility: read.visibility,
          visibilityUnreadable: false,
          visibilityRegistry,
        }));
        yield* publish;
      }
      return;
    }
    // Another process (the CLI) joined or left: take its membership and whatever list it left.
    const read = yield* readVisibilityFile;
    yield* Ref.set(state, {
      membership,
      list: yield* readList(membership),
      removed: Option.isNone(membership) && current.removed,
      visibility: read.readable ? read.visibility : HIDDEN_FROM_ALL,
      visibilityUnreadable: !read.readable,
      visibilityRegistry: "unknown" as const,
    });
    yield* publish;
  });

  /**
   * Closes the sockets of sessions that another process (`devices remove` or `leave` in the CLI,
   * `auth session revoke`) revoked in the database: this server never saw those writes, and
   * `listActive` no longer returns the rows. It must not fail or skip a sync.
   */
  const announceRevoked = sessions.announceRevoked().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not close the sockets of sessions revoked elsewhere.", { cause }),
    ),
    Effect.asVoid,
    Effect.withSpan("DeviceDirectory.announceRevoked"),
  );

  /**
   * Tells whether the registry holds this computer's setting, and delivers it when it does not. The
   * computer's own file is the truth: a registry that is unreachable, or too old to have the setting,
   * never changes what this computer accepts.
   */
  const settleRegistryVisibility = Effect.fn("DeviceDirectory.settleRegistryVisibility")(function* (
    target: RegistryClient.RegistryTarget,
  ) {
    const local = yield* Ref.get(state);
    const mine = Option.getOrUndefined(local.list)?.devices.find(
      (device) => device.id === target.deviceId,
    );
    // An unreadable file has no setting to compare or deliver.
    if (mine === undefined || local.visibilityUnreadable) return;
    const settle = Effect.fn("DeviceDirectory.settle")(function* (
      visibilityRegistry: DeviceVisibilityRegistryState,
    ) {
      const current = yield* Ref.get(state);
      if (current.visibilityRegistry === visibilityRegistry) return;
      yield* Ref.set(state, { ...current, visibilityRegistry });
      yield* writeRegistryState(visibilityRegistry, current.visibility);
      yield* publish;
    });
    if (mine.visibility === undefined) return yield* settle("unsupported");
    if (sameVisibility(mine.visibility, local.visibility)) return yield* settle("synced");
    // Delivering is not under the gate, so the setting may change while a call is in flight: confirm
    // the value that went out is still the current one, and deliver again when it is not.
    for (let attempt = 0; attempt < MAX_DELIVERIES; attempt += 1) {
      const sending = yield* Ref.get(state);
      if (sending.visibilityUnreadable) return;
      const pushed = yield* registry.setVisibility(target, sending.visibility).pipe(Effect.result);
      if (pushed._tag === "Failure") {
        yield* Effect.logWarning("Could not tell the server who may see this computer.", {
          kind: pushed.failure.kind,
          code: pushed.failure.code,
        });
        return yield* settle(
          pushed.failure.kind === "rejected" && pushed.failure.status === 404
            ? "unsupported"
            : "pending",
        );
      }
      const after = yield* Ref.get(state);
      if (!after.visibilityUnreadable && sameVisibility(after.visibility, sending.visibility)) {
        return yield* settle("synced");
      }
    }
    return yield* settle("pending");
  });

  const syncRegistry = Effect.fn("DeviceDirectory.sync")(function* () {
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
          ...(body.hiddenPeers === undefined ? {} : { hiddenPeers: body.hiddenPeers }),
        };
        if (!next.devices.some((device) => device.id === membership.deviceId)) {
          // The registry answered with a list that does not contain this computer.
          yield* clearLocked("removed");
          return;
        }
        yield* persistList(next);
        yield* Ref.update(state, (current) => ({ ...current, list: Option.some(next) }));
        // A computer hidden from this one still signs in to it, so its sessions stay.
        yield* reconcile(everyKnownId(next), (yield* Ref.get(state)).visibility);
        // Every successful answer moves `fetchedAt`, which clients show as the last sync.
        yield* publish;
      }),
    );
    yield* settleRegistryVisibility(target);
    return yield* status;
  });

  // Whatever the pull finds, including no membership or an unreachable registry, the check runs.
  const sync = () => syncRegistry().pipe(Effect.ensuring(announceRevoked));

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
          // A computer that joins starts visible to everyone, whatever an earlier membership chose.
          yield* secrets.remove(VISIBILITY_SECRET).pipe(storageFailure);
          yield* secrets.remove(VISIBILITY_SYNC_SECRET).pipe(storageFailure);
          yield* Ref.set(state, {
            membership: Option.some(membership),
            list: Option.none(),
            removed: false,
            visibility: DEFAULT_VISIBILITY,
            visibilityUnreadable: false,
            visibilityRegistry: "unknown",
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
    visibility: readVisibility,
    setVisibility: Effect.fn("DeviceDirectory.setVisibility")(function* (input) {
      const next = normalizeVisibility(input);
      yield* gate.withPermits(1)(
        Effect.gen(function* () {
          yield* secrets
            .set(
              VISIBILITY_SECRET,
              new TextEncoder().encode(encodeStoredVisibility({ v: 1, visibility: next })),
            )
            .pipe(storageFailure);
          const current = yield* Ref.get(state);
          const changed = current.visibilityUnreadable || !sameVisibility(next, current.visibility);
          yield* Ref.set(state, {
            ...current,
            visibility: next,
            visibilityUnreadable: false,
            visibilityRegistry: changed ? "pending" : current.visibilityRegistry,
          });
          if (changed) yield* writeRegistryState("pending", next);
          // The devices the setting now excludes lose their sessions, and their sockets close, before this returns.
          yield* reconcile(
            Option.match(current.list, { onNone: () => null, onSome: everyKnownId }),
            next,
          );
          yield* publish;
        }),
      );
    }),
  });
});

export const layer = Layer.effect(DeviceDirectory, make);
