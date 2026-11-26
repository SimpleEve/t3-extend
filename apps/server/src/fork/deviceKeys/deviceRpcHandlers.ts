import {
  DeviceKeysError,
  type DeviceVisibility,
  FORK_DEVICE_KEYS_WS_METHODS,
  T3X_LOCAL_OWNER_SUBJECT,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as DeviceKeysService from "./DeviceKeysService.ts";

const notLocalOwner = new DeviceKeysError({
  reason: "not_local_owner",
  message: "Only this computer's own app can manage devices.",
});

/**
 * Handlers for the `devices.*` RPCs on one WebSocket session. The only check is the session's
 * signed subject: `desktop-bootstrap` exists only for the desktop app's own grant, so a
 * pairing-link browser or another device's session cannot pass it whatever scopes it holds.
 */
export const makeDeviceRpcHandlers = Effect.fn("makeDeviceRpcHandlers")(function* (session: {
  readonly subject: string;
}) {
  const service = yield* DeviceKeysService.DeviceKeysService;
  const owner = session.subject === T3X_LOCAL_OWNER_SUBJECT;
  const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    owner ? effect : Effect.fail(notLocalOwner);
  const M = FORK_DEVICE_KEYS_WS_METHODS;
  return {
    [M.status]: () => guarded(service.status),
    [M.subscribe]: () => (owner ? service.subscribe : Stream.fail(notLocalOwner)),
    [M.join]: (input: { readonly invite: string; readonly name: string }) =>
      guarded(service.join(input)),
    [M.leave]: () => guarded(service.leave),
    [M.invite]: ({ kind }: { readonly kind: "computer" | "phone" }) =>
      guarded(service.invite(kind)),
    [M.cancelInvite]: ({ id }: { readonly id: string }) =>
      guarded(service.cancelInvite(id).pipe(Effect.as({}))),
    [M.remove]: ({ deviceId }: { readonly deviceId: string }) => guarded(service.remove(deviceId)),
    [M.rename]: ({ deviceId, name }: { readonly deviceId: string; readonly name: string }) =>
      guarded(service.rename(deviceId, name)),
    [M.refresh]: () => guarded(service.refresh),
    [M.setVisibility]: (input: DeviceVisibility) => guarded(service.setVisibility(input)),
    [M.signAssertion]: (input: {
      readonly audienceEnvironmentId: string;
      readonly dpopThumbprint: string;
    }) => guarded(service.signAssertion(input)),
  };
});
