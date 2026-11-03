// fork: what the phone knows about the server it joined, and the rules for keeping it current
// (design Q10 / Q11). Plain async code over injected storage, network and clock, so the rules that
// matter are tested without a phone: join asks before it sends, the registry is pinned, a removed
// device drops its environments, and refresh is by foreground event, never by timer.
import type { RegistryDevice } from "@t3tools/contracts";
import { b64u, type DeviceKeyPair } from "@t3tools/shared/forkDeviceKeys/jws";
import { redemptionOf } from "@t3tools/shared/forkDeviceKeys/invite";
import { signAssertion as signAssertionToken } from "@t3tools/shared/forkDeviceKeys/assertion";
import { normalizeDeviceName } from "@t3tools/shared/forkDeviceKeys/subdomain";
import { canonicalOrigin } from "@t3tools/shared/forkDeviceKeys/proof";
import type { DeviceDirectoryView } from "@t3tools/client-runtime/fork/deviceKeys/discovery";
import { readInvite } from "@t3tools/client-runtime/fork/deviceKeys/inviteReading";

import { createDeviceKey, deleteDeviceKey, readDeviceKey, type SecretStore } from "./deviceKey";
import {
  RegistryError,
  fetchRegistryInfo,
  joinRegistry,
  listRegistryDevices,
  type RegistryEnvironment,
} from "./registryClient";

export const MEMBERSHIP_ITEM = "t3x.membership.v1";
/** Foreground returns closer together than this share one registry round trip. */
export const REFRESH_INTERVAL_MS = 30_000;

export interface Membership {
  readonly v: 1;
  readonly origin: string;
  readonly registryId: string;
  readonly deviceId: string;
  readonly name: string;
  readonly joinedAt: number;
}

export type DeviceSyncState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "not-joined"; readonly removed: boolean }
  /** The stored key or membership cannot be read back; the only way out is to leave and join again. */
  | { readonly _tag: "damaged" }
  /** The keychain would not answer; nothing was changed. */
  | { readonly _tag: "storage-error" }
  | {
      readonly _tag: "joined";
      readonly membership: Membership;
      readonly devices: ReadonlyArray<RegistryDevice>;
      readonly rev: number | null;
      /** Epoch seconds of the last answer from the registry. */
      readonly fetchedAt: number | null;
      /** Set while the last refresh failed; cleared by the next answer. */
      readonly unreachable: boolean;
    };

export type JoinFailure =
  | "invalid"
  | "expired"
  | "wrong-kind"
  | "already-joined"
  | "name-invalid"
  | "invite-used"
  | "invite-expired"
  | "invite-invalid"
  | "rate-limited"
  | "unreachable"
  | "wrong-server"
  | "storage";

export type JoinResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: JoinFailure };

export interface DeviceSyncDeps {
  readonly store: SecretStore;
  readonly registry: RegistryEnvironment;
  /** Hands the computers to the connection stack; null removes everything it saved. */
  readonly applyView: (view: DeviceDirectoryView | null) => Promise<void>;
}

const sameMembership = (value: unknown): Membership | null => {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  if (
    m.v !== 1 ||
    typeof m.origin !== "string" ||
    typeof m.registryId !== "string" ||
    typeof m.deviceId !== "string" ||
    typeof m.name !== "string" ||
    typeof m.joinedAt !== "number"
  ) {
    return null;
  }
  try {
    if (canonicalOrigin(m.origin) !== m.origin) return null;
  } catch {
    return null;
  }
  return m as unknown as Membership;
};

export const viewOfDevices = (
  membership: Pick<Membership, "origin" | "registryId">,
  devices: ReadonlyArray<RegistryDevice>,
): DeviceDirectoryView => ({
  pin: { origin: membership.origin, registryId: membership.registryId },
  recordsEnvironmentIds: true,
  computers: devices
    .filter((device) => device.kind === "computer")
    .map((device) => ({
      deviceId: device.id,
      name: device.name,
      url: device.url ?? null,
      environmentId: device.environmentId ?? null,
      self: false,
      ...(device.online === undefined ? {} : { online: device.online }),
    })),
});

const failureOfRegistry = (error: unknown): JoinFailure => {
  if (!(error instanceof RegistryError)) return "unreachable";
  if (error.kind === "unreachable") return "unreachable";
  if (error.kind === "protocol") return "wrong-server";
  switch (error.code) {
    case "invite_used":
      return "invite-used";
    case "invite_expired":
      return "invite-expired";
    case "name_invalid":
      return "name-invalid";
    case "rate_limited":
      return "rate-limited";
    default:
      return error.status === 429 ? "rate-limited" : "invite-invalid";
  }
};

export function createDeviceSync(deps: DeviceSyncDeps) {
  let state: DeviceSyncState = { _tag: "loading" };
  let key: DeviceKeyPair | null = null;
  let lastAttemptMs = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let busy = false;
  const listeners = new Set<() => void>();

  const set = (next: DeviceSyncState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const nowMs = () => deps.registry.nowSeconds() * 1000;

  const joined = () => (state._tag === "joined" ? state : null);

  const forget = async (removed: boolean) => {
    // The saved environments go first: nothing may keep a way in once the membership is gone.
    await deps.applyView(null);
    await deps.store.deleteItemAsync(MEMBERSHIP_ITEM);
    await deleteDeviceKey(deps.store);
    key = null;
    lastAttemptMs = Number.NEGATIVE_INFINITY;
    set({ _tag: "not-joined", removed });
  };

  const load = async (): Promise<void> => {
    try {
      const storedMembership = await deps.store.getItemAsync(MEMBERSHIP_ITEM);
      const storedKey = await readDeviceKey(deps.store);
      if (storedMembership === null) {
        // A key with no membership is a join that never finished: nothing is registered under it.
        if (storedKey._tag !== "missing") await deleteDeviceKey(deps.store);
        set({ _tag: "not-joined", removed: false });
        return;
      }
      let membership: Membership | null = null;
      try {
        membership = sameMembership(JSON.parse(storedMembership));
      } catch {
        membership = null;
      }
      if (
        membership === null ||
        storedKey._tag !== "ready" ||
        storedKey.key.id !== membership.deviceId
      ) {
        set({ _tag: "damaged" });
        return;
      }
      key = storedKey.key;
      set({
        _tag: "joined",
        membership,
        devices: [],
        rev: null,
        fetchedAt: null,
        unreachable: false,
      });
    } catch {
      set({ _tag: "storage-error" });
    }
  };

  const runRefresh = async (): Promise<void> => {
    const current = joined();
    if (current === null || key === null) return;
    lastAttemptMs = nowMs();
    const { membership } = current;
    try {
      const result = await listRegistryDevices(
        deps.registry,
        { origin: membership.origin, registryId: membership.registryId, key },
        current.rev ?? undefined,
      );
      const now = deps.registry.nowSeconds();
      // The answer is for the membership that asked: a leave or a new join in between wins.
      if (state._tag !== "joined" || state.membership !== membership) return;
      if (result._tag === "NotModified") {
        set({ ...state, fetchedAt: now, unreachable: false });
        return;
      }
      const { body } = result;
      if (!body.devices.some((device) => device.id === membership.deviceId)) {
        // Listed by a registry that does not know this device: treat it as removed.
        await forget(true);
        return;
      }
      set({
        ...state,
        devices: body.devices,
        rev: body.rev,
        fetchedAt: now,
        unreachable: false,
      });
      await deps.applyView(viewOfDevices(membership, body.devices));
    } catch (error) {
      if (state._tag !== "joined" || state.membership !== membership) return;
      if (error instanceof RegistryError && error.code === "device_unknown") {
        await forget(true);
        return;
      }
      set({ ...state, unreachable: true });
    }
  };

  const refresh = (options: { readonly force?: boolean } = {}): Promise<void> => {
    if (inFlight !== null) return inFlight;
    if (options.force !== true && nowMs() - lastAttemptMs < REFRESH_INTERVAL_MS) {
      return Promise.resolve();
    }
    inFlight = runRefresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    state: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,

    /**
     * Brings the list up to date. A foreground return calls this without `force` and is skipped
     * when it follows another within thirty seconds; joining and a pull to refresh force it.
     */
    refresh,

    join: async (inviteText: string, deviceName: string): Promise<JoinResult> => {
      if (state._tag !== "not-joined" || busy) return { ok: false, failure: "already-joined" };
      const reading = readInvite(inviteText, nowMs(), "phone");
      if (reading._tag !== "ready") {
        return { ok: false, failure: reading._tag === "empty" ? "invalid" : reading._tag };
      }
      const name = normalizeDeviceName(deviceName);
      if (name === null) return { ok: false, failure: "name-invalid" };
      const { invite } = reading;
      busy = true;
      try {
        const origin = canonicalOrigin(invite.origin);
        // The address answers for the registry the invite was made for, or nothing is sent to it.
        const info = await fetchRegistryInfo(deps.registry, origin);
        if (info.registryId !== invite.registryId) return { ok: false, failure: "wrong-server" };
        const created = await createDeviceKey(deps.store, deps.registry.randomBytes).catch(
          () => null,
        );
        if (created === null) return { ok: false, failure: "storage" };
        try {
          const answer = await joinRegistry(deps.registry, {
            origin,
            invite: redemptionOf(invite),
            key: created,
            name,
          });
          if (answer.deviceId !== created.id || answer.registryId !== invite.registryId) {
            throw new RegistryError("protocol");
          }
          const membership: Membership = {
            v: 1,
            origin,
            registryId: answer.registryId,
            deviceId: answer.deviceId,
            name: answer.name,
            joinedAt: deps.registry.nowSeconds(),
          };
          await deps.store.setItemAsync(MEMBERSHIP_ITEM, JSON.stringify(membership));
          key = created;
          set({
            _tag: "joined",
            membership,
            devices: [],
            rev: null,
            fetchedAt: null,
            unreachable: false,
          });
        } catch (error) {
          await deleteDeviceKey(deps.store).catch(() => {});
          key = null;
          return {
            ok: false,
            failure: error instanceof RegistryError ? failureOfRegistry(error) : "storage",
          };
        }
      } catch (error) {
        return { ok: false, failure: failureOfRegistry(error) };
      } finally {
        busy = false;
      }
      await refresh({ force: true });
      return { ok: true };
    },

    leave: async (): Promise<void> => {
      if (state._tag === "loading") return;
      await forget(false);
    },

    /** The computers this phone last saw, as the connection code reads them. Null while not joined. */
    currentView: (): DeviceDirectoryView | null => {
      const current = joined();
      return current === null || current.fetchedAt === null
        ? null
        : viewOfDevices(current.membership, current.devices);
    },

    /** A pass for one computer, signed with this phone's key. Null when there is no usable key. */
    signPass: (input: {
      readonly audienceEnvironmentId: string;
      readonly dpopThumbprint: string;
    }): string | null => {
      const current = joined();
      if (current === null || key === null) return null;
      return signAssertionToken({
        privateKey: key.privateKey,
        deviceId: current.membership.deviceId,
        audienceEnvironmentId: input.audienceEnvironmentId,
        registryId: current.membership.registryId,
        dpopThumbprint: input.dpopThumbprint,
        iat: deps.registry.nowSeconds(),
        jti: b64u.encode(deps.registry.randomBytes(16)),
      }).assertion;
    },
  };
}

export type DeviceSync = ReturnType<typeof createDeviceSync>;
