// @effect-diagnostics nodeBuiltinImport:off globalTimers:off anyUnknownInErrorContext:off - a promise-shaped wrapper that calls RPC methods by name, so their errors are untyped here.
// The same WebSocket RPC a desktop renderer or phone uses, driven from plain async code.
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
  type DevicesSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import { E2eFailure } from "./util.ts";

const makeClient = RpcClient.make(WsRpcGroup);

type CallMethod = (payload: unknown) => Effect.Effect<unknown, unknown>;
type StreamMethod = (payload: unknown) => Stream.Stream<unknown, unknown>;

/** A failed RPC, with the typed error's `reason` (`not_local_owner`, `registry_unreachable`, ...) when it has one. */
// @effect-diagnostics-next-line extendsNativeError:off - fork: e2e script, runs without an Effect runtime.
export class RpcFailure extends Error {
  readonly reason: string | undefined;
  readonly tag: string;
  constructor(error: unknown) {
    const fields =
      typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
    const reason = typeof fields.reason === "string" ? fields.reason : undefined;
    const tag = typeof fields._tag === "string" ? fields._tag : "error";
    const detail = typeof fields.message === "string" ? fields.message : JSON.stringify(error);
    super(`${tag}${reason === undefined ? "" : ` (${reason})`}: ${detail}`);
    this.name = "RpcFailure";
    this.reason = reason;
    this.tag = tag;
  }
}

export interface RpcConnection {
  readonly call: (method: string, payload?: unknown) => Promise<unknown>;
  /** Runs `onValue` for every item until the connection closes. */
  readonly stream: (method: string, payload: unknown, onValue: (value: unknown) => void) => void;
  readonly close: () => Promise<void>;
}

export async function openRpc(url: string): Promise<RpcConnection> {
  const scope = Scope.makeUnsafe();
  const client = await Effect.runPromise(
    Effect.gen(function* () {
      const protocol = yield* Layer.buildWithScope(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Socket.layerWebSocket(url, { openTimeout: "30 seconds" })),
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
          Layer.provide(RpcSerialization.layerJson),
        ),
        scope,
      );
      return yield* makeClient.pipe(Effect.provide(protocol), Scope.provide(scope));
    }),
  );
  const methods = client as unknown as Record<string, CallMethod | StreamMethod | undefined>;
  const method = (name: string) => {
    const found = methods[name];
    if (found === undefined) throw new E2eFailure(`The RPC client has no method ${name}.`);
    return found;
  };
  return {
    call: async (name, payload = {}) => {
      const result = await Effect.runPromise(Effect.result((method(name) as CallMethod)(payload)));
      if (result._tag === "Failure") throw new RpcFailure(result.failure);
      return result.success;
    },
    stream: (name, payload, onValue) => {
      Effect.runFork(
        Stream.runForEach((method(name) as StreamMethod)(payload), (value) =>
          Effect.sync(() => onValue(value)),
        ).pipe(Effect.ignore),
      );
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

export const rpcUrl = (origin: string, ticket: string): string =>
  `${origin.replace(/^http/u, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`;

interface Waiter {
  readonly predicate: (snapshot: DevicesSnapshot) => boolean;
  readonly resolve: (snapshot: DevicesSnapshot) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** The `devices.subscribe` stream of one computer, kept so a scenario can wait for a snapshot it needs. */
export class SnapshotWatcher {
  latest: DevicesSnapshot | undefined;
  readonly #waiters = new Set<Waiter>();

  constructor(connection: RpcConnection) {
    connection.stream("devices.subscribe", {}, (value) => {
      this.latest = value as DevicesSnapshot;
      for (const waiter of this.#waiters) {
        if (waiter.predicate(this.latest)) {
          clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
          waiter.resolve(this.latest);
        }
      }
    });
  }

  /** Resolves with the latest snapshot if it already qualifies, else with the next one that does. */
  waitFor(
    label: string,
    timeoutMs: number,
    predicate: (snapshot: DevicesSnapshot) => boolean,
  ): Promise<DevicesSnapshot> {
    if (this.latest !== undefined && predicate(this.latest)) return Promise.resolve(this.latest);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new E2eFailure(
              `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}; the last snapshot was ${JSON.stringify(this.latest?.status)}.`,
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  /** The next snapshot whose last-sync time is later than `fetchedAt`. */
  nextSync(fetchedAt: number | null, timeoutMs: number): Promise<DevicesSnapshot> {
    return this.waitFor(
      "the next sync with the server",
      timeoutMs,
      (snapshot) => (snapshot.status.fetchedAt ?? 0) > (fetchedAt ?? 0),
    );
  }
}
