// Who may reach the device-management service: only the session whose signed subject is the
// desktop app's own. Scopes are availability hints; they decide nothing here.
import { FORK_DEVICE_KEYS_WS_METHODS, T3X_LOCAL_OWNER_SUBJECT } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeDeviceRpcHandlers } from "./deviceRpcHandlers.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";

const status = { state: "not_joined" } as never;

const makeFake = () => {
  const calls: Array<string> = [];
  const note = <A>(name: string, value: A) =>
    Effect.suspend(() => {
      calls.push(name);
      return Effect.succeed(value);
    });
  const service = DeviceKeysService.DeviceKeysService.of({
    status: note("status", status),
    subscribe: Stream.suspend(() => {
      calls.push("subscribe");
      return Stream.empty;
    }),
    refresh: note("refresh", status),
    join: () => note("join", status),
    leave: note("leave", status),
    invite: () => note("invite", { id: "i", invite: "t3x1.x", expiresAt: 1 }),
    cancelInvite: () => note("cancelInvite", undefined),
    remove: () => note("remove", { removedAt: 1, rev: 1, pendingComputers: [] }),
    rename: () => note("rename", { id: "d", name: "n" }),
    signAssertion: () => note("signAssertion", { assertion: "a", expiresAt: 1 }),
    setVisibility: () => note("setVisibility", status),
  });
  return { calls, layer: Layer.succeed(DeviceKeysService.DeviceKeysService, service) };
};

const M = FORK_DEVICE_KEYS_WS_METHODS;
const build = (subject: string) => makeDeviceRpcHandlers({ subject });
type Handlers = Effect.Success<ReturnType<typeof build>>;
const invoke = (handlers: Handlers, method: string) => {
  switch (method) {
    case M.status:
      return handlers[M.status]();
    case M.subscribe:
      return Stream.runDrain(handlers[M.subscribe]());
    case M.join:
      return handlers[M.join]({ invite: "t3x1.x", name: "n" });
    case M.leave:
      return handlers[M.leave]();
    case M.invite:
      return handlers[M.invite]({ kind: "phone" });
    case M.cancelInvite:
      return handlers[M.cancelInvite]({ id: "i" });
    case M.remove:
      return handlers[M.remove]({ deviceId: "d" });
    case M.rename:
      return handlers[M.rename]({ deviceId: "d", name: "n" });
    case M.refresh:
      return handlers[M.refresh]();
    case M.setVisibility:
      return handlers[M.setVisibility]({ mode: "hidden_from_all", deviceIds: [] });
    default:
      return handlers[M.signAssertion]({ audienceEnvironmentId: "e", dpopThumbprint: "j" });
  }
};

describe("devices.* handlers", () => {
  const methods = Object.values(M);

  it.effect("refuse every method to every session that is not the local owner", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      for (const subject of [
        "one-time-token",
        "t3x-device:computer:abc",
        "t3x-device:phone:abc",
        "",
        `${T3X_LOCAL_OWNER_SUBJECT}x`,
      ]) {
        const handlers = yield* build(subject).pipe(Effect.provide(fake.layer));
        for (const method of methods) {
          const error = yield* invoke(handlers, method).pipe(Effect.flip);
          assert.equal(
            (error as { reason?: string }).reason,
            "not_local_owner",
            `${subject} ${method}`,
          );
        }
      }
      assert.deepEqual(fake.calls, []);
    }),
  );

  it.effect("let the desktop app's own session reach the service", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const handlers = yield* build(T3X_LOCAL_OWNER_SUBJECT).pipe(Effect.provide(fake.layer));
      for (const method of methods) yield* invoke(handlers, method);
      assert.sameMembers(fake.calls, [
        "status",
        "subscribe",
        "refresh",
        "leave",
        "invite",
        "cancelInvite",
        "remove",
        "rename",
        "signAssertion",
        "setVisibility",
        "join",
      ]);
    }),
  );
});
