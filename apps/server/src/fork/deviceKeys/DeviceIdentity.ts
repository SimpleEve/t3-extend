// fork: this computer's device key (design Q4 / 3.10). The private key lives in the server's secret
// store (0600 file in a 0700 directory, atomic writes) and never leaves this process.
import {
  b64u,
  deviceKeyFromPrivate,
  generateDeviceKey,
  type DeviceKeyPair,
} from "@t3tools/shared/forkDeviceKeys/jws";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

export class DeviceStoreError extends Schema.TaggedError<DeviceStoreError>()("DeviceStoreError", {
  resource: Schema.String,
  /** `corrupt` is never repaired silently: a regenerated key would be a different device. */
  problem: Schema.Literals(["corrupt", "io"]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `The ${this.resource} is ${this.problem === "corrupt" ? "unreadable" : "not accessible"}.`;
  }
}

export const DEVICE_KEY_SECRET = "fork-device-key";

const KeyDocument = Schema.Struct({ v: Schema.Literal(1), d: Schema.String });
const decodeKeyDocument = Schema.decodeUnknownOption(Schema.fromJsonString(KeyDocument));
const encodeKeyDocument = Schema.encodeSync(Schema.fromJsonString(KeyDocument));

export class DeviceIdentity extends Context.Service<
  DeviceIdentity,
  {
    /** None when this computer has never joined (or has left). */
    readonly peek: Effect.Effect<Option.Option<DeviceKeyPair>, DeviceStoreError>;
    readonly getOrCreate: Effect.Effect<DeviceKeyPair, DeviceStoreError>;
    readonly remove: Effect.Effect<void, DeviceStoreError>;
  }
>()("t3/fork/deviceKeys/DeviceIdentity") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const io = (cause: unknown) =>
    new DeviceStoreError({ resource: "device key", problem: "io", cause });

  const read = Effect.suspend(() => secrets.get(DEVICE_KEY_SECRET)).pipe(
    Effect.mapError(io),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (bytes) => {
          const document = decodeKeyDocument(new TextDecoder().decode(bytes));
          const privateKey = Option.flatMap(document, (doc) =>
            Option.fromNullishOr(b64u.decode(doc.d)),
          );
          return Option.isSome(privateKey) && privateKey.value.length === 32
            ? Effect.try({
                try: () => Option.some(deviceKeyFromPrivate(privateKey.value)),
                catch: (cause) =>
                  new DeviceStoreError({ resource: "device key", problem: "corrupt", cause }),
              })
            : Effect.fail(new DeviceStoreError({ resource: "device key", problem: "corrupt" }));
        },
      }),
    ),
  );

  return DeviceIdentity.of({
    peek: lock.withPermits(1)(read),
    getOrCreate: lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* read;
        if (Option.isSome(existing)) return existing.value;
        const key = generateDeviceKey();
        yield* secrets
          .set(
            DEVICE_KEY_SECRET,
            new TextEncoder().encode(encodeKeyDocument({ v: 1, d: b64u.encode(key.privateKey) })),
          )
          .pipe(Effect.mapError(io));
        return key;
      }),
    ),
    remove: lock.withPermits(1)(secrets.remove(DEVICE_KEY_SECRET).pipe(Effect.mapError(io))),
  });
});

export const layer = Layer.effect(DeviceIdentity, make);
