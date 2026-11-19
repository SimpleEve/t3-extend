import {
  ApnsAlertTemplates,
  ApsEnvironment,
  AuthSessionId,
  PushDeliveryOutcome,
  PushNotificationPreferences,
  PushRegistrationError,
  type PushRegistrationInput,
  type PushRegistrationStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { APNS_HOSTS } from "./apnsTransport.ts"; // fork: iOS
import * as PushApns from "./PushApns.ts"; // fork: iOS
import { insecureEndpointsDecision, validatePushEndpoint } from "./pushEndpoint.ts";
import { decodeWebPushKeys } from "./webPush.ts";

// fork: stored in the secret store, so the file is 0600 inside a 0700 directory and
// written atomically. Endpoints and keys are credentials: anyone holding them can push.
const SECRET_NAME = "fork-push-registrations";
const MAX_REGISTRATIONS = 32;

const StoredDelivery = Schema.Struct({
  at: Schema.String,
  outcome: PushDeliveryOutcome,
  httpStatus: Schema.NullOr(Schema.Int),
});
export type StoredPushDelivery = typeof StoredDelivery.Type;

/** Android: no `kind`, so files written before iOS existed still read. */
export const StoredUnifiedPushRegistration = Schema.Struct({
  sessionId: AuthSessionId,
  deviceId: Schema.String,
  label: Schema.String,
  environmentLabel: Schema.String,
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  preferences: PushNotificationPreferences,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastDelivery: Schema.NullOr(StoredDelivery),
});
export type StoredUnifiedPushRegistration = typeof StoredUnifiedPushRegistration.Type;

// fork: iOS. The token is a credential, like an endpoint: it is stored here and never logged.
export const StoredApnsPushRegistration = Schema.Struct({
  kind: Schema.Literal("apns"),
  sessionId: AuthSessionId,
  deviceId: Schema.String,
  label: Schema.String,
  environmentLabel: Schema.String,
  deviceToken: Schema.String,
  apsEnvironment: ApsEnvironment,
  bundleId: Schema.String,
  templates: Schema.optional(ApnsAlertTemplates),
  preferences: PushNotificationPreferences,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastDelivery: Schema.NullOr(StoredDelivery),
});
export type StoredApnsPushRegistration = typeof StoredApnsPushRegistration.Type;

export const StoredPushRegistration = Schema.Union([
  StoredApnsPushRegistration,
  StoredUnifiedPushRegistration,
]);
export type StoredPushRegistration = typeof StoredPushRegistration.Type;

export const isApnsRegistration = (
  registration: StoredPushRegistration,
): registration is StoredApnsPushRegistration => "kind" in registration;

/** What a registration is delivered to: the endpoint, or the APNs device token. */
export const registrationTarget = (registration: StoredPushRegistration): string =>
  isApnsRegistration(registration) ? registration.deviceToken : registration.endpoint;

/**
 * Which delivery target-and-keys a registration holds. A result for one identity must not land on
 * a registration that has since changed it, even under the same session and the same token.
 */
const registrationIdentity = (registration: StoredPushRegistration): string =>
  JSON.stringify(
    isApnsRegistration(registration)
      ? ["apns", registration.deviceToken, registration.bundleId, registration.apsEnvironment]
      : ["push", registration.endpoint, registration.p256dh, registration.auth],
  );

const RegistrationsDocument = Schema.Struct({
  version: Schema.Literal(1),
  registrations: Schema.Array(StoredPushRegistration),
});
const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(RegistrationsDocument));
const encodeDocument = Schema.encodeSync(Schema.fromJsonString(RegistrationsDocument));

export const endpointHost = (endpoint: string): string | null => {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
};

/** Host only, for status and logs: Apple's gateway for an iPhone, the endpoint's host otherwise. */
export const registrationHost = (registration: StoredPushRegistration): string | null =>
  isApnsRegistration(registration)
    ? APNS_HOSTS[registration.apsEnvironment]
    : endpointHost(registration.endpoint);

export const toPushRegistrationStatus = (
  registration: StoredPushRegistration | undefined,
): PushRegistrationStatus =>
  registration === undefined
    ? { registered: false, endpointHost: null, updatedAt: null, lastDelivery: null }
    : {
        registered: true,
        endpointHost: registrationHost(registration),
        updatedAt: registration.updatedAt,
        lastDelivery: registration.lastDelivery,
      };

export class PushRegistrations extends Context.Service<
  PushRegistrations,
  {
    readonly list: Effect.Effect<ReadonlyArray<StoredPushRegistration>>;
    readonly getBySession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<StoredPushRegistration>>;
    /** Replaces this session's registration, and any other session's for the same device or endpoint. */
    readonly upsert: (input: {
      readonly sessionId: AuthSessionId;
      readonly registration: PushRegistrationInput;
    }) => Effect.Effect<StoredPushRegistration, PushRegistrationError>;
    /** Removes this session's registration and any other session's for the same device. */
    readonly remove: (input: {
      readonly sessionId: AuthSessionId;
      readonly deviceId: string;
    }) => Effect.Effect<boolean, PushRegistrationError>;
    readonly removeSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, PushRegistrationError>;
    /** Drops registrations of sessions that are no longer active, such as expired ones. */
    readonly retainSessions: (
      active: ReadonlySet<string>,
    ) => Effect.Effect<number, PushRegistrationError>;
    /**
     * Writes the result onto this exact registration; one that has changed since is left alone.
     * `apsEnvironment` moves an iPhone's registration to the Apple host that accepted its token.
     */
    readonly recordDelivery: (
      registration: StoredPushRegistration,
      delivery: Omit<StoredPushDelivery, "at">,
      apsEnvironment?: ApsEnvironment,
    ) => Effect.Effect<void, PushRegistrationError>;
    /**
     * Removes the registration only if it is still this exact one (endpoint and keys, or token,
     * app and Apple host), so a re-registration survives a late 410.
     */
    readonly removeIfCurrent: (
      registration: StoredPushRegistration,
    ) => Effect.Effect<void, PushRegistrationError>;
  }
>()("t3/fork/push/PushRegistrations") {}

export const make = Effect.fn("PushRegistrations.make")(function* (options: {
  readonly allowInsecure: boolean;
  /** Whether this environment has an APNs key; without one an iPhone cannot register. */
  readonly apnsConfigured?: boolean;
}) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);

  const loaded = yield* secrets.get(SECRET_NAME).pipe(
    Effect.map((bytes) =>
      Option.isSome(bytes)
        ? Option.map(
            decodeDocument(new TextDecoder().decode(bytes.value)),
            (document) => document.registrations,
          )
        : Option.some<ReadonlyArray<StoredPushRegistration>>([]),
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not read push registrations; starting empty.", {
        error: error.message,
      }).pipe(Effect.as(Option.none<ReadonlyArray<StoredPushRegistration>>())),
    ),
  );
  if (Option.isNone(loaded)) {
    yield* Effect.logWarning("Push registrations were unreadable and are being ignored.");
  }
  const state = yield* Ref.make<ReadonlyArray<StoredPushRegistration>>(
    Option.getOrElse(loaded, () => []),
  );

  const persist = (registrations: ReadonlyArray<StoredPushRegistration>) =>
    secrets.set(
      SECRET_NAME,
      new TextEncoder().encode(encodeDocument({ version: 1, registrations })),
    );

  // Every mutation runs under the lock so concurrent RPCs cannot interleave read-modify-write.
  // The file is written first and memory follows, so a failed write changes nothing and the
  // caller is told, instead of being shown success for a registration that would not survive a restart.
  const mutate = <A>(
    change: (
      current: ReadonlyArray<StoredPushRegistration>,
    ) => readonly [next: ReadonlyArray<StoredPushRegistration>, result: A],
  ): Effect.Effect<A, PushRegistrationError> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const [next, result] = change(current);
        if (next === current) return result;
        yield* persist(next).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not save push registrations.", {
              error: error.message,
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new PushRegistrationError({
                    reason: "storage",
                    message: "The push registration could not be saved on this environment.",
                  }),
                ),
              ),
            ),
          ),
        );
        yield* Ref.set(state, next);
        return result;
      }),
    );

  const upsert: PushRegistrations["Service"]["upsert"] = Effect.fn("PushRegistrations.upsert")(
    function* ({ sessionId, registration }) {
      // Where the alerts go, and how to write the stored entry once that is known to be usable.
      type Prepared = {
        readonly target: string;
        readonly build: (input: {
          readonly previous: StoredPushRegistration | undefined;
          readonly now: string;
        }) => StoredPushRegistration;
      };
      const lastDeliveryFor = (
        previous: StoredPushRegistration | undefined,
        next: StoredPushRegistration,
      ) =>
        previous !== undefined && registrationIdentity(previous) === registrationIdentity(next)
          ? previous.lastDelivery
          : null;
      const prepared: Prepared = yield* Effect.gen(function* () {
        if ("kind" in registration) {
          if (options.apnsConfigured !== true) {
            return yield* new PushRegistrationError({
              reason: "apns_not_configured",
              message: "This environment has no APNs key, so it cannot push to an iPhone.",
            });
          }
          const deviceToken = registration.deviceToken.toLowerCase();
          return {
            target: deviceToken,
            build: ({ previous, now }) => ({
              kind: "apns",
              sessionId,
              deviceId: registration.deviceId,
              label: registration.label,
              environmentLabel: registration.environmentLabel,
              deviceToken,
              apsEnvironment: registration.apsEnvironment,
              bundleId: registration.bundleId,
              ...(registration.templates === undefined
                ? {}
                : { templates: registration.templates }),
              preferences: registration.preferences,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
              lastDelivery: null,
            }),
          } satisfies Prepared;
        }
        const endpoint = validatePushEndpoint(registration.endpoint, options);
        if (endpoint === null) {
          return yield* new PushRegistrationError({
            reason: "invalid_endpoint",
            message: "The push endpoint must be an https URL at a public address.",
          });
        }
        const keys = decodeWebPushKeys(registration.p256dh, registration.auth);
        if (keys === null) {
          return yield* new PushRegistrationError({
            reason: "invalid_keys",
            message: "The push subscription keys are not a valid P-256 key and auth secret.",
          });
        }
        return {
          target: endpoint.url,
          build: ({ previous, now }) => ({
            sessionId,
            deviceId: registration.deviceId,
            label: registration.label,
            environmentLabel: registration.environmentLabel,
            endpoint: endpoint.url,
            p256dh: keys.p256dh.toString("base64url"),
            auth: keys.auth.toString("base64url"),
            preferences: registration.preferences,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
            lastDelivery: null,
          }),
        } satisfies Prepared;
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const stored = yield* mutate((current) => {
        const previous = current.find((entry) => entry.sessionId === sessionId);
        const built = prepared.build({ previous, now });
        const next = { ...built, lastDelivery: lastDeliveryFor(previous, built) };
        const others = current.filter(
          (entry) =>
            entry.sessionId !== sessionId &&
            entry.deviceId !== registration.deviceId &&
            registrationTarget(entry) !== prepared.target,
        );
        if (previous === undefined && others.length >= MAX_REGISTRATIONS) {
          return [current, null] as const;
        }
        return [[...others, next], next] as const;
      });
      if (stored === null) {
        return yield* new PushRegistrationError({
          reason: "too_many",
          message: "This environment already has the maximum number of push registrations.",
        });
      }
      return stored;
    },
  );

  const getBySession = Effect.fn("PushRegistrations.getBySession")(function* (
    sessionId: AuthSessionId,
  ) {
    const current = yield* Ref.get(state);
    return Option.fromUndefinedOr(current.find((entry) => entry.sessionId === sessionId));
  });
  const remove = Effect.fn("PushRegistrations.remove")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly deviceId: string;
  }) {
    return yield* mutate((current) => {
      const next = current.filter(
        (entry) => entry.sessionId !== input.sessionId && entry.deviceId !== input.deviceId,
      );
      return [next.length === current.length ? current : next, next.length !== current.length];
    });
  });
  const removeSession = Effect.fn("PushRegistrations.removeSession")(function* (
    sessionId: AuthSessionId,
  ) {
    return yield* mutate((current) => {
      const next = current.filter((entry) => entry.sessionId !== sessionId);
      return [next.length === current.length ? current : next, next.length !== current.length];
    });
  });
  const retainSessions = Effect.fn("PushRegistrations.retainSessions")(function* (
    active: ReadonlySet<string>,
  ) {
    return yield* mutate((current) => {
      const next = current.filter((entry) => active.has(entry.sessionId));
      return [next.length === current.length ? current : next, current.length - next.length];
    });
  });
  const isSame = (entry: StoredPushRegistration, registration: StoredPushRegistration) =>
    entry.sessionId === registration.sessionId &&
    registrationIdentity(entry) === registrationIdentity(registration);
  const recordDelivery = Effect.fn("PushRegistrations.recordDelivery")(function* (
    registration: StoredPushRegistration,
    delivery: Omit<StoredPushDelivery, "at">,
    apsEnvironment?: ApsEnvironment,
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* mutate((current) => {
      if (!current.some((entry) => isSame(entry, registration))) return [current, null];
      return [
        current.map((entry) => {
          if (!isSame(entry, registration)) return entry;
          const delivered = { ...entry, lastDelivery: { at, ...delivery } };
          return apsEnvironment !== undefined && isApnsRegistration(delivered)
            ? { ...delivered, apsEnvironment }
            : delivered;
        }),
        null,
      ];
    });
  });
  const removeIfCurrent = Effect.fn("PushRegistrations.removeIfCurrent")(function* (
    registration: StoredPushRegistration,
  ) {
    yield* mutate((current) => {
      const next = current.filter((entry) => !isSame(entry, registration));
      return [next.length === current.length ? current : next, null];
    });
  });

  return PushRegistrations.of({
    list: Ref.get(state),
    getBySession,
    upsert,
    remove,
    removeSession,
    retainSessions,
    recordDelivery,
    removeIfCurrent,
  });
});

export const layer = Layer.effect(
  PushRegistrations,
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const config = yield* ServerConfig;
    // The transport layer logs the decision; this only follows it.
    const decision = insecureEndpointsDecision({
      environment,
      development: config.devUrl !== undefined,
    });
    const apns = yield* PushApns.PushApns;
    return yield* make({ allowInsecure: decision === "allowed", apnsConfigured: apns.configured });
  }),
);
