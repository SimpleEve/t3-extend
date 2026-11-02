import { FORK_PUSH_WS_METHODS, type AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PushNotifier from "./PushNotifier.ts";
import * as PushRegistrations from "./PushRegistrations.ts";

/**
 * Handlers for the `push.*` RPCs, for the websocket session they are called
 * on. A registration belongs to that session, so revoking the session ends it.
 */
export const makePushRpcHandlers = Effect.fn("makePushRpcHandlers")(function* (
  sessionId: AuthSessionId,
) {
  const registrations = yield* PushRegistrations.PushRegistrations;
  const notifier = yield* PushNotifier.PushNotifier;
  const statusFor = (deviceId: string) =>
    registrations
      .getBySession(sessionId)
      .pipe(
        Effect.map((registration) =>
          PushRegistrations.toPushRegistrationStatus(
            Option.filter(registration, (entry) => entry.deviceId === deviceId).pipe(
              Option.getOrUndefined,
            ),
          ),
        ),
      );
  return {
    [FORK_PUSH_WS_METHODS.register]: (
      input: Parameters<typeof registrations.upsert>[0]["registration"],
    ) =>
      registrations.upsert({ sessionId, registration: input }).pipe(
        // Threads already waiting when the first device registers are not news.
        Effect.tap(() => notifier.prepare),
        Effect.map((registration) => PushRegistrations.toPushRegistrationStatus(registration)),
      ),
    [FORK_PUSH_WS_METHODS.unregister]: ({ deviceId }: { readonly deviceId: string }) =>
      registrations.remove({ sessionId, deviceId }).pipe(Effect.map((removed) => ({ removed }))),
    [FORK_PUSH_WS_METHODS.status]: ({ deviceId }: { readonly deviceId: string }) =>
      statusFor(deviceId),
    [FORK_PUSH_WS_METHODS.sendTest]: ({ deviceId }: { readonly deviceId: string }) =>
      notifier.sendTest({ sessionId, deviceId }),
  };
});
