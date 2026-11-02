import {
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
import { ALLOW_INSECURE_PUSH_ENDPOINTS_ENV, validatePushEndpoint } from "./pushEndpoint.ts";
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

export const StoredPushRegistration = Schema.Struct({
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
export type StoredPushRegistration = typeof StoredPushRegistration.Type;

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

export const toPushRegistrationStatus = (
  registration: StoredPushRegistration | undefined,
): PushRegistrationStatus =>
  registration === undefined
    ? { registered: false, endpointHost: null, updatedAt: null, lastDelivery: null }
    : {
        registered: true,
        endpointHost: endpointHost(registration.endpoint),
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
    }) => Effect.Effect<boolean>;
    readonly removeSession: (sessionId: AuthSessionId) => Effect.Effect<boolean>;
    /** Drops registrations of sessions that are no longer active, such as expired ones. */
    readonly retainSessions: (active: ReadonlySet<string>) => Effect.Effect<number>;
    readonly recordDelivery: (
      sessionId: AuthSessionId,
      delivery: Omit<StoredPushDelivery, "at">,
    ) => Effect.Effect<void>;
    /** Removes the registration only if it still holds this endpoint, so a re-registration survives a late 410. */
    readonly removeIfEndpoint: (sessionId: AuthSessionId, endpoint: string) => Effect.Effect<void>;
  }
>()("t3/fork/push/PushRegistrations") {}

export const make = Effect.fn("PushRegistrations.make")(function* (options: {
  readonly allowInsecure: boolean;
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
  const mutate = <A>(
    change: (
      current: ReadonlyArray<StoredPushRegistration>,
    ) => readonly [next: ReadonlyArray<StoredPushRegistration>, result: A],
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const [next, result] = change(current);
        if (next === current) return result;
        yield* Ref.set(state, next);
        yield* persist(next).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not save push registrations.", { error: error.message }),
          ),
        );
        return result;
      }),
    );

  const upsert: PushRegistrations["Service"]["upsert"] = Effect.fn("PushRegistrations.upsert")(
    function* ({ sessionId, registration }) {
      const endpoint = validatePushEndpoint(registration.endpoint, options);
      if (endpoint === null) {
        return yield* new PushRegistrationError({
          reason: "invalid_endpoint",
          message: "The push endpoint must be an https URL that is not on this machine.",
        });
      }
      const keys = decodeWebPushKeys(registration.p256dh, registration.auth);
      if (keys === null) {
        return yield* new PushRegistrationError({
          reason: "invalid_keys",
          message: "The push subscription keys are not a valid P-256 key and auth secret.",
        });
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const stored = yield* mutate((current) => {
        const previous = current.find((entry) => entry.sessionId === sessionId);
        const next: StoredPushRegistration = {
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
          lastDelivery:
            previous?.endpoint === endpoint.url ? (previous?.lastDelivery ?? null) : null,
        };
        const others = current.filter(
          (entry) =>
            entry.sessionId !== sessionId &&
            entry.deviceId !== registration.deviceId &&
            entry.endpoint !== endpoint.url,
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
  const recordDelivery = Effect.fn("PushRegistrations.recordDelivery")(function* (
    sessionId: AuthSessionId,
    delivery: Omit<StoredPushDelivery, "at">,
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* mutate((current) => {
      if (!current.some((entry) => entry.sessionId === sessionId)) return [current, null];
      return [
        current.map((entry) =>
          entry.sessionId === sessionId ? { ...entry, lastDelivery: { at, ...delivery } } : entry,
        ),
        null,
      ];
    });
  });
  const removeIfEndpoint = Effect.fn("PushRegistrations.removeIfEndpoint")(function* (
    sessionId: AuthSessionId,
    endpoint: string,
  ) {
    yield* mutate((current) => {
      const next = current.filter(
        (entry) => !(entry.sessionId === sessionId && entry.endpoint === endpoint),
      );
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
    removeIfEndpoint,
  });
});

export const layer = Layer.effect(
  PushRegistrations,
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    return yield* make({ allowInsecure: environment[ALLOW_INSECURE_PUSH_ENDPOINTS_ENV] === "1" });
  }),
);
