// An in-memory stand-in for the registry, behind the same `RegistryClient` interface. Tests steer
// reachability and membership through `FakeRegistry`; the real wire protocol is covered against the
// real registry process in RegistryClient.live.test.ts.
import type {
  DeviceKind,
  DeviceVisibility,
  RegistryDevice,
  RegistryHiddenPeer,
} from "@t3tools/contracts";
import {
  deviceIdOf,
  generateDeviceKey,
  type DeviceKeyPair,
} from "@t3tools/shared/forkDeviceKeys/jws";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RegistryClient from "./RegistryClient.ts";

export const FAKE_ORIGIN = "https://t3.example.test";
export const FAKE_REGISTRY_ID = "fakereg2";

export interface FakeRegistryState {
  rev: number;
  devices: Array<RegistryDevice>;
  reachable: boolean;
  /** The registry no longer knows the asking device. */
  forgetCaller: boolean;
  /** Answer every signed call with this registry error code. */
  rejectWith: string | undefined;
  /** Answer every call with this client error, as the real client would raise it. */
  failWith: RegistryClient.RegistryClientError | undefined;
  readonly calls: Array<{ readonly op: string; readonly detail?: unknown }>;
  /** The invite string `join` accepts. */
  invite: string | undefined;
  /** Computers hidden from the asker: what the real registry sends in `hiddenPeers`. */
  hiddenPeers: Array<RegistryHiddenPeer>;
  /** False plays a registry from before visibility: no `visibility` on the entry, no such route. */
  visibilitySupported: boolean;
  /** What the registry holds for the asking computer. */
  visibility: DeviceVisibility;
  /** Runs inside every `setVisibility` call, before the registry applies it. */
  onSetVisibility: Effect.Effect<void>;
}

export class FakeRegistry extends Context.Service<
  FakeRegistry,
  {
    readonly state: FakeRegistryState;
    /** Registers a device straight into the list, as a join by another device would. */
    readonly addDevice: (input: {
      readonly kind: DeviceKind;
      readonly name: string;
      readonly environmentId?: string;
      readonly lastSyncAt?: number;
    }) => DeviceKeyPair & { readonly entry: RegistryDevice };
    readonly removeDevice: (id: string) => void;
    readonly callsTo: (op: string) => number;
  }
>()("t3/fork/deviceKeys/registryFake.testkit/FakeRegistry") {}

const rejected = (code: string, status = 400) =>
  Effect.fail(new RegistryClient.RegistryClientError({ kind: "rejected", status, code }));

export const layerFakeRegistry = Layer.unwrap(
  Effect.sync(() => {
    const state: FakeRegistryState = {
      rev: 1,
      devices: [],
      reachable: true,
      forgetCaller: false,
      rejectWith: undefined,
      failWith: undefined,
      calls: [],
      invite: undefined,
      hiddenPeers: [],
      visibilitySupported: true,
      visibility: { mode: "visible_to_all", deviceIds: [] },
      onSetVisibility: Effect.void,
    };
    let counter = 0;
    const record = (op: string, detail?: unknown) => state.calls.push({ op, detail });
    const unreachable = () =>
      Effect.fail(new RegistryClient.RegistryClientError({ kind: "unreachable" }));
    const gate = (target?: { readonly deviceId: string }) => {
      if (!state.reachable) return unreachable();
      if (state.failWith !== undefined) return Effect.fail(state.failWith);
      if (state.rejectWith !== undefined) return rejected(state.rejectWith);
      if (target !== undefined && state.forgetCaller) return rejected("device_unknown", 401);
      return Effect.void;
    };
    const entryFor = (
      key: DeviceKeyPair,
      input: { kind: DeviceKind; name: string; environmentId?: string; lastSyncAt?: number },
      order: number,
    ): RegistryDevice => {
      const subdomain =
        input.kind === "computer"
          ? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
          : undefined;
      return {
        id: key.id,
        name: input.name,
        kind: input.kind,
        jwk: key.jwk,
        ...(subdomain === undefined
          ? {}
          : { subdomain, url: `https://${subdomain}.t3.example.test` }),
        ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
        createdAt: 1000 + order,
        lastSeenAt: 1000 + order,
        ...(input.lastSyncAt === undefined ? {} : { lastSyncAt: input.lastSyncAt }),
      };
    };

    const client = RegistryClient.RegistryClient.of({
      info: () =>
        gate().pipe(
          Effect.andThen(
            Effect.sync(() => {
              record("info");
              return {
                apiVersion: 1 as const,
                registryId: FAKE_REGISTRY_ID,
                domain: "t3.example.test",
                publicPort: 443,
              };
            }),
          ),
        ),
      join: (input) =>
        gate().pipe(
          Effect.andThen(
            Effect.suspend(() => {
              record("join", { name: input.name, invite: input.invite });
              if (state.invite === undefined || input.invite !== state.invite) {
                return rejected("invite_invalid");
              }
              const key = { privateKey: input.privateKey, jwk: input.jwk, id: "" };
              const entry = entryFor(
                { ...key, id: deviceIdOf(input.jwk) },
                { kind: input.kind, name: input.name, environmentId: input.environmentId },
                (counter += 1),
              );
              state.devices.push(entry);
              state.rev += 1;
              return Effect.succeed({
                registryId: FAKE_REGISTRY_ID,
                deviceId: entry.id,
                name: entry.name,
                ...(entry.subdomain === undefined ? {} : { subdomain: entry.subdomain }),
                ...(entry.url === undefined ? {} : { url: entry.url }),
                rev: state.rev,
              });
            }),
          ),
        ),
      listDevices: (target) =>
        gate(target).pipe(
          Effect.andThen(
            Effect.sync(() => {
              record("listDevices");
              return {
                registryId: FAKE_REGISTRY_ID,
                rev: state.rev,
                devices: state.devices.map((device) =>
                  state.visibilitySupported && device.id === target.deviceId
                    ? { ...device, visibility: state.visibility }
                    : device,
                ),
                ...(state.hiddenPeers.length === 0 ? {} : { hiddenPeers: [...state.hiddenPeers] }),
              };
            }),
          ),
        ),
      createInvite: (target, kind) =>
        gate(target).pipe(
          Effect.andThen(
            Effect.sync(() => {
              record("createInvite", { kind });
              return { id: "AAAAAAAAAAA", invite: `t3x1.fake-${kind}`, expiresAt: 5000 };
            }),
          ),
        ),
      cancelInvite: (target, id) =>
        gate(target).pipe(Effect.andThen(Effect.sync(() => void record("cancelInvite", { id })))),
      removeDevice: (target, deviceId) =>
        gate(target).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              record("removeDevice", { deviceId });
              const before = state.devices.length;
              state.devices = state.devices.filter((device) => device.id !== deviceId);
              if (state.devices.length === before) return rejected("not_found", 404);
              state.rev += 1;
              return Effect.succeed({ removedAt: 2000, rev: state.rev });
            }),
          ),
        ),
      renameDevice: (target, deviceId, name) =>
        gate(target).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              record("renameDevice", { deviceId, name });
              const index = state.devices.findIndex((device) => device.id === deviceId);
              const found = state.devices[index];
              if (found === undefined) return rejected("not_found", 404);
              state.devices[index] = { ...found, name };
              state.rev += 1;
              return Effect.succeed({ id: deviceId, name });
            }),
          ),
        ),
      reportEnvironment: (target, environmentId) =>
        gate(target).pipe(
          Effect.andThen(Effect.sync(() => void record("reportEnvironment", { environmentId }))),
        ),
      setVisibility: (target, visibility) =>
        gate(target).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              record("setVisibility", visibility);
              return state.onSetVisibility;
            }).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  if (!state.visibilitySupported) return rejected("not_found", 404);
                  state.visibility = visibility;
                  state.rev += 1;
                  return Effect.succeed({ rev: state.rev, visibility });
                }),
              ),
            ),
          ),
        ),
    });

    const fake = FakeRegistry.of({
      state,
      addDevice: (input) => {
        const key = generateDeviceKey();
        const entry = entryFor(key, input, (counter += 1));
        state.devices.push(entry);
        state.rev += 1;
        return { ...key, entry };
      },
      removeDevice: (id) => {
        state.devices = state.devices.filter((device) => device.id !== id);
        state.rev += 1;
      },
      callsTo: (op) => state.calls.filter((call) => call.op === op).length,
    });
    return Layer.mergeAll(
      Layer.succeed(RegistryClient.RegistryClient, client),
      Layer.succeed(FakeRegistry, fake),
    );
  }),
);
