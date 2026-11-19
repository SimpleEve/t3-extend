// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Apple's push gateway speaks HTTP/2 only, and Effect has no HTTP/2 client; the ping deadline sits inside its callback API.
import * as NodeHttp2 from "node:http2";

import type { ApsEnvironment } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

// fork: one POST to Apple's push gateway. The hosts are Apple's and fixed, so none of the address
// checks that guard a phone-supplied UnifiedPush endpoint apply, and none of them is loosened.

export const APNS_HOSTS = {
  development: "api.sandbox.push.apple.com",
  production: "api.push.apple.com",
} as const satisfies Record<ApsEnvironment, string>;

const RESPONSE_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 4_096;

export class ApnsTransportError extends Schema.TaggedError<ApnsTransportError>()(
  "ApnsTransportError",
  {},
) {}

export class ApnsTransport extends Context.Service<
  ApnsTransport,
  {
    /** `reason` is Apple's error word (such as `BadDeviceToken`), never anything about the request. */
    readonly send: (input: {
      readonly apsEnvironment: ApsEnvironment;
      readonly deviceToken: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }) => Effect.Effect<
      { readonly status: number; readonly reason: string | null },
      ApnsTransportError
    >;
  }
>()("t3/fork/push/apnsTransport") {}

const readReason = (body: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(body);
    const reason =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { reason?: unknown }).reason
        : null;
    return typeof reason === "string" ? reason.slice(0, 100) : null;
  } catch {
    return null;
  }
};

export interface ApnsTransportOptions {
  /** Where each environment's gateway is. Tests point it at a local server. */
  readonly origin?: (apsEnvironment: ApsEnvironment) => string;
  readonly responseTimeoutMs?: number;
  /** How long a connection gets to answer a ping after a request went unanswered. */
  readonly pingTimeoutMs?: number;
}

export const make = Effect.fn("ApnsTransport.make")(function* (options: ApnsTransportOptions = {}) {
  const originOf =
    options.origin ?? ((apsEnvironment: ApsEnvironment) => `https://${APNS_HOSTS[apsEnvironment]}`);
  // Apple wants connections kept open and reused, not one per push.
  const sessions = new Map<ApsEnvironment, NodeHttp2.ClientHttp2Session>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of sessions.values()) session.destroy();
      sessions.clear();
    }),
  );

  const sessionFor = (apsEnvironment: ApsEnvironment) => {
    const existing = sessions.get(apsEnvironment);
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing;
    const session = NodeHttp2.connect(originOf(apsEnvironment));
    const forget = () => {
      if (sessions.get(apsEnvironment) === session) sessions.delete(apsEnvironment);
    };
    // A dropped connection is replaced by the next push; the one in flight fails and is retried.
    // A connection the network dropped silently never emits close, so `request` drops it too.
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", () => {
      forget();
      session.close();
    });
    // An idle gateway connection must not keep the server process alive.
    session.unref();
    sessions.set(apsEnvironment, session);
    return session;
  };

  const drop = (apsEnvironment: ApsEnvironment, session: NodeHttp2.ClientHttp2Session) => {
    if (sessions.get(apsEnvironment) === session) sessions.delete(apsEnvironment);
    session.destroy();
  };

  // A request that got no answer may be the only sign of a connection the network dropped, or may
  // be one slow request on a healthy connection that other pushes share. A ping tells them apart.
  const dropIfDead = (apsEnvironment: ApsEnvironment, session: NodeHttp2.ClientHttp2Session) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        drop(apsEnvironment, session);
        resolve();
      }, options.pingTimeoutMs ?? PING_TIMEOUT_MS);
      try {
        const sent = session.ping((error) => {
          clearTimeout(timer);
          if (error !== null) drop(apsEnvironment, session);
          resolve();
        });
        if (sent) return;
      } catch {
        // A session already gone cannot answer either.
      }
      clearTimeout(timer);
      drop(apsEnvironment, session);
      resolve();
    });

  const request = (input: Parameters<ApnsTransport["Service"]["send"]>[0], signal: AbortSignal) =>
    new Promise<{ status: number; reason: string | null }>((resolve, reject) => {
      const session = sessionFor(input.apsEnvironment);
      const stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${input.deviceToken}`,
        ...input.headers,
      });
      const abort = () => stream.close(NodeHttp2.constants.NGHTTP2_CANCEL);
      let timedOut = false;
      signal.addEventListener("abort", abort, { once: true });
      stream.setTimeout(options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS, () => {
        timedOut = true;
        abort();
      });
      let status = 0;
      let received = "";
      stream.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (received.length < MAX_RESPONSE_BYTES) received += chunk;
      });
      // One stream failing says nothing about the connection or the other requests on it.
      stream.on("error", reject);
      stream.on("close", () => {
        signal.removeEventListener("abort", abort);
        if (status !== 0) {
          resolve({ status, reason: status === 200 ? null : readReason(received) });
        } else if (timedOut) {
          void dropIfDead(input.apsEnvironment, session).then(() =>
            reject(new Error("no response")),
          );
        } else {
          reject(new Error("no response"));
        }
      });
      stream.end(input.body);
    });

  const send: ApnsTransport["Service"]["send"] = Effect.fn("ApnsTransport.send")((input) =>
    Effect.tryPromise({
      try: (signal) => request(input, signal),
      catch: () => new ApnsTransportError({}),
    }),
  );

  return ApnsTransport.of({ send });
});

export const layer = Layer.effect(ApnsTransport, make());
