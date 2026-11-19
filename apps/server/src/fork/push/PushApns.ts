import type { PushDeliveryOutcome, PushNotificationPayload } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { loadApnsConfig, type ApnsConfig } from "./apnsConfig.ts";
import { APNS_TOKEN_REUSE_SECONDS, signApnsProviderToken } from "./apnsJwt.ts";
import { apnsOutcome, buildApnsRequestBody } from "./apnsPayload.ts";
import * as ApnsTransport from "./apnsTransport.ts";
import type { StoredApnsPushRegistration } from "./PushRegistrations.ts";

// fork: sends alerts straight to Apple's push gateway with this environment's own key.

const NOTIFICATION_TTL_SECONDS = 3_600;
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class PushApns extends Context.Service<
  PushApns,
  {
    /** False when the three `T3EXTEND_APNS_*` variables did not give a usable key. */
    readonly configured: boolean;
    readonly send: (input: {
      readonly registration: StoredApnsPushRegistration;
      readonly payload: PushNotificationPayload;
    }) => Effect.Effect<{ readonly outcome: PushDeliveryOutcome; readonly status: number | null }>;
  }
>()("t3/fork/push/PushApns") {}

export const make = Effect.fn("PushApns.make")(function* (config: ApnsConfig) {
  const transport = yield* ApnsTransport.ApnsTransport;
  const token = yield* Ref.make<{ readonly jwt: string; readonly issuedAt: number } | null>(null);

  const providerToken = Effect.fn("PushApns.providerToken")(function* (
    credentials: Extract<ApnsConfig, { status: "configured" }>["credentials"],
  ) {
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const cached = yield* Ref.get(token);
    if (cached !== null && now - cached.issuedAt < APNS_TOKEN_REUSE_SECONDS) return cached.jwt;
    const jwt = signApnsProviderToken({ credentials, issuedAtSeconds: now });
    yield* Ref.set(token, { jwt, issuedAt: now });
    return jwt;
  });

  const send: PushApns["Service"]["send"] = Effect.fn("PushApns.send")(function* (input) {
    if (config.status !== "configured") return { outcome: "rejected", status: null } as const;
    const { registration, payload } = input;
    const jwt = yield* providerToken(config.credentials);
    const nowSeconds = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const post = (apsEnvironment: StoredApnsPushRegistration["apsEnvironment"]) =>
      transport.send({
        apsEnvironment,
        deviceToken: registration.deviceToken,
        headers: {
          authorization: `bearer ${jwt}`,
          "apns-topic": registration.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(nowSeconds + NOTIFICATION_TTL_SECONDS),
          // The same alert id replaces itself instead of showing twice after a retry.
          "apns-collapse-id": payload.id,
          "content-type": "application/json",
        },
        body: encodeBody(buildApnsRequestBody({ payload, templates: registration.templates })),
      });
    // The signing certificate, not the app variant the phone reports, decides which host its
    // token belongs to; a self-built Release signed for development holds a sandbox token.
    const other = registration.apsEnvironment === "production" ? "development" : "production";
    const response = yield* post(registration.apsEnvironment).pipe(
      Effect.filterOrElse(
        (first) => !(first.status === 400 && first.reason === "BadDeviceToken"),
        () => post(other),
      ),
      Effect.option,
    );
    if (response._tag === "None") return { outcome: "unreachable", status: null } as const;
    const { status, reason } = response.value;
    // Only Apple's own words are logged; the token and the key never are.
    if (status !== 200) yield* Effect.logWarning("APNs refused a push", { status, reason });
    if (reason === "ExpiredProviderToken") yield* Ref.set(token, null);
    return { outcome: apnsOutcome(status, reason), status } as const;
  });

  return PushApns.of({ configured: config.status === "configured", send });
});

export const layer = Layer.effect(
  PushApns,
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const config = yield* loadApnsConfig(environment);
    if (config.status === "configured") {
      yield* Effect.logInfo("APNs push is on: iPhones can register for alerts.", {
        keyId: config.credentials.keyId,
      });
    } else if (config.status === "invalid") {
      yield* Effect.logWarning(`APNs push is off: ${config.problem}.`);
    }
    return yield* make(config);
  }),
).pipe(Layer.provide(ApnsTransport.layer));

/** For environments and tests that never push to an iPhone. */
export const disabled = PushApns.of({
  configured: false,
  send: Effect.fn("PushApns.disabledSend")(() =>
    Effect.succeed({ outcome: "rejected", status: null } as const),
  ),
});
