// fork: the ports the user allowed by hand (research/remote-loopback-forwarding.md 5.6.3). A
// service that no T3 terminal or agent started is refused as `not-owned`; a port on this list is
// forwarded anyway, to every device and session of this environment. A grant is only ever by port:
// the process behind it can be restarted and is still the same service to the user.
import {
  LoopbackGatewayAllowedPort,
  LoopbackGatewayAllowedPortError,
  type LoopbackGatewayAllowedPortFailure,
} from "@t3tools/contracts";
import {
  LOOPBACK_GATEWAY_BLOCKED_PORTS,
  parseLoopbackGatewayPort,
} from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../../config.ts";
import { writeFileAtomic } from "../deviceKeys/atomicWrite.ts";

const LOOPBACK_GATEWAY_ALLOWED_PORTS_FILE = "loopback-gateway-allowed-ports.json";
export const LOOPBACK_GATEWAY_MAX_ALLOWED_PORTS = 64;

const Document = Schema.Struct({
  version: Schema.Literal(1),
  ports: Schema.Array(LoopbackGatewayAllowedPort).check(
    Schema.isMaxLength(LOOPBACK_GATEWAY_MAX_ALLOWED_PORTS),
  ),
});
const documentJson = Schema.fromJsonString(Schema.toCodecJson(Document));
const decodeDocument = Schema.decodeUnknownOption(documentJson);
const encodeDocument = Schema.encodeSync(documentJson);

type AllowedPorts = ReadonlyArray<LoopbackGatewayAllowedPort>;

export class LoopbackGatewayGrants extends Context.Service<
  LoopbackGatewayGrants,
  {
    /** In the order they were allowed. */
    readonly list: Effect.Effect<AllowedPorts>;
    /** The list now, then each new list; a tunnel that stands on an allowed port watches it. */
    readonly changes: Stream.Stream<AllowedPorts>;
    readonly allow: (port: number) => Effect.Effect<AllowedPorts, LoopbackGatewayAllowedPortError>;
    readonly remove: (port: number) => Effect.Effect<AllowedPorts, LoopbackGatewayAllowedPortError>;
  }
>()("t3/fork/loopbackGateway/LoopbackGatewayGrants") {}

const failure = (reason: LoopbackGatewayAllowedPortFailure, message: string) =>
  new LoopbackGatewayAllowedPortError({ reason, message });

export interface LoopbackGatewayGrantsOptions {
  /** The file the list is kept in. */
  readonly file: string;
  /** Ports this server itself listens on, on top of the blocked-port table. */
  readonly reservedPorts: Effect.Effect<ReadonlySet<number>>;
}

export const make = Effect.fn("LoopbackGateway.makeGrants")(function* (
  options: LoopbackGatewayGrantsOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // A missing file is an empty list. One that cannot be read or decoded is too, with a warning:
  // refusing more is the safe direction, and the next change writes a good file over it.
  const load = fs.readFileString(options.file).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound"
          ? Effect.succeed<AllowedPorts>([])
          : Effect.logWarning("loopback gateway: could not read the allowed ports", {
              reason: error.message,
            }).pipe(Effect.as<AllowedPorts>([])),
      onSuccess: (raw) => {
        const document = decodeDocument(raw);
        if (document._tag === "Some") {
          const seen = new Set<number>();
          return Effect.succeed(
            document.value.ports.filter((entry) => !seen.has(entry.port) && seen.add(entry.port)),
          );
        }
        return Effect.logWarning(
          "loopback gateway: the allowed ports file is not valid, treating it as empty",
        ).pipe(Effect.as<AllowedPorts>([]));
      },
    }),
  );

  const state = yield* SubscriptionRef.make(yield* load);
  const lock = yield* Semaphore.make(1);

  const save = (ports: AllowedPorts) =>
    fs.makeDirectory(path.dirname(options.file), { recursive: true }).pipe(
      Effect.andThen(
        writeFileAtomic(options.file, encodeDocument({ version: 1, ports }), 0o600).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      ),
      Effect.andThen(SubscriptionRef.set(state, ports)),
      Effect.as(ports),
      Effect.tapError((error) =>
        Effect.logWarning("loopback gateway: could not save the allowed ports", {
          reason: error.message,
        }),
      ),
      Effect.mapError(() => failure("not-saved", "The allowed ports could not be saved.")),
    );

  const checkPort = (port: number): Effect.Effect<void, LoopbackGatewayAllowedPortError> =>
    parseLoopbackGatewayPort(String(port)) === null
      ? Effect.fail(failure("invalid-port", "A port is a number from 1 to 65535."))
      : Effect.void;

  const allow = Effect.fn("LoopbackGateway.allowPort")(function* (port: number) {
    yield* checkPort(port);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (LOOPBACK_GATEWAY_BLOCKED_PORTS.has(port) || (yield* options.reservedPorts).has(port)) {
          return yield* failure("reserved", "This port is reserved and can't be forwarded.");
        }
        const current = yield* SubscriptionRef.get(state);
        if (current.some((entry) => entry.port === port)) return current;
        if (current.length >= LOOPBACK_GATEWAY_MAX_ALLOWED_PORTS) {
          return yield* failure(
            "limit-reached",
            `At most ${LOOPBACK_GATEWAY_MAX_ALLOWED_PORTS} ports can be allowed. Remove one first.`,
          );
        }
        return yield* save([...current, { port, allowedAt: yield* DateTime.now }]);
      }),
    );
  });

  const remove = Effect.fn("LoopbackGateway.removeAllowedPort")(function* (port: number) {
    yield* checkPort(port);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        return current.some((entry) => entry.port === port)
          ? yield* save(current.filter((entry) => entry.port !== port))
          : current;
      }),
    );
  });

  return LoopbackGatewayGrants.of({
    list: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    allow,
    remove,
  });
});

export const layer = Layer.effect(
  LoopbackGatewayGrants,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make({
      file: path.join(config.stateDir, LOOPBACK_GATEWAY_ALLOWED_PORTS_FILE),
      reservedPorts: Effect.succeed(new Set([config.port])),
    });
  }),
);
