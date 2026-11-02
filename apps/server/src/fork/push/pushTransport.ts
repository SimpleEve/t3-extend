// @effect-diagnostics nodeBuiltinImport:off -- The address check hooks the socket's DNS lookup, which Effect does not expose.
import * as NodeDns from "node:dns";
import * as NodeModule from "node:module";
import type * as NodeNet from "node:net";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Undici from "undici";

import { ServerConfig } from "../../config.ts";
import { isPublicAddress, literalIp, systemLocalAddresses } from "./pushAddress.ts";
import { ALLOW_INSECURE_PUSH_ENDPOINTS_ENV, insecureEndpointsDecision } from "./pushEndpoint.ts";

// fork: sends one encrypted push to an endpoint a paired device chose. The address the socket
// connects to is checked inside the connection's own DNS lookup, so a name that rebinds between
// a check and the connect cannot reach the local network.

// undici is external to the CLI bundle; see outboundHttp.ts.
const requireUndici = NodeModule.createRequire(import.meta.url);

const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 10_000;
const BLOCKED_CODE = "EPUSHBLOCKED";

export class PushTransportError extends Schema.TaggedError<PushTransportError>()(
  "PushTransportError",
  {
    reason: Schema.Literals(["blocked", "unreachable"]),
  },
) {}

export class PushTransport extends Context.Service<
  PushTransport,
  {
    /** The HTTP status only; the response body is never read. */
    readonly post: (input: {
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    }) => Effect.Effect<number, PushTransportError>;
  }
>()("t3/fork/push/pushTransport") {}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export interface GuardedLookupOptions {
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;
  readonly localAddresses: () => ReadonlyArray<string>;
  /** Development only: skips the check so a loopback ntfy can be used. */
  readonly allowPrivate: boolean;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | ReadonlyArray<ResolvedAddress>,
  family?: number,
) => void;
interface LookupRequest {
  readonly all?: boolean | undefined;
  readonly family?: number | string | undefined;
}

const blocked = (hostname: string) =>
  Object.assign(new Error(`${hostname} resolves to a non-public address.`), {
    code: BLOCKED_CODE,
  });

/**
 * A `net.connect` lookup that resolves every A and AAAA record and refuses the connection if any
 * of them is not public. The socket then connects to one of the addresses that was checked.
 */
export function makeGuardedLookup(options: GuardedLookupOptions) {
  return (hostname: string, request: LookupRequest | LookupCallback, callback?: LookupCallback) => {
    const done = typeof request === "function" ? request : callback;
    const wanted = typeof request === "function" ? undefined : request;
    if (done === undefined) return;
    options.resolve(hostname).then(
      (addresses) => {
        const policy = { localAddresses: options.localAddresses() };
        if (
          addresses.length === 0 ||
          (!options.allowPrivate &&
            !addresses.every((entry) => isPublicAddress(entry.address, policy)))
        ) {
          done(blocked(hostname));
          return;
        }
        const family = Number(wanted?.family ?? 0);
        const usable =
          family === 4 || family === 6
            ? addresses.filter((entry) => entry.family === family)
            : addresses;
        const first = usable[0];
        if (first === undefined) {
          done(blocked(hostname));
        } else if (wanted?.all === true) {
          done(null, usable);
        } else {
          done(null, first.address, first.family);
        }
      },
      (error: NodeJS.ErrnoException) => done(error),
    );
  };
}

const isBlocked = (error: unknown): boolean => {
  for (
    let depth = 0, current = error;
    depth < 5 && typeof current === "object" && current !== null;
    depth += 1
  ) {
    if ("code" in current && current.code === BLOCKED_CODE) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};

export interface PushTransportOptions {
  readonly allowPrivate: boolean;
  readonly resolve?: GuardedLookupOptions["resolve"];
  readonly localAddresses?: GuardedLookupOptions["localAddresses"];
}

export const make = Effect.fn("PushTransport.make")(function* (options: PushTransportOptions) {
  const undici = requireUndici("undici") as typeof Undici;
  const localAddresses = options.localAddresses ?? systemLocalAddresses;
  const agent = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        // Direct connections only: a proxy would resolve the name itself, past the check below.
        new undici.Agent({
          allowH2: false,
          connect: {
            timeout: CONNECT_TIMEOUT_MS,
            // Node ignores the address argument when the lookup reports an error.
            lookup: makeGuardedLookup({
              resolve:
                options.resolve ??
                ((hostname) => NodeDns.promises.lookup(hostname, { all: true, verbatim: true })),
              localAddresses,
              allowPrivate: options.allowPrivate,
            }) as unknown as NodeNet.LookupFunction,
          },
        }),
    ),
    (created) => Effect.promise(() => created.close()),
  );

  const send = async (
    input: { url: string; headers: Readonly<Record<string, string>>; body: Uint8Array },
    signal: AbortSignal,
  ) => {
    // A literal IP never reaches the lookup, so it is checked here.
    const ip = literalIp(new URL(input.url).hostname);
    if (
      !options.allowPrivate &&
      ip !== null &&
      !isPublicAddress(ip, { localAddresses: localAddresses() })
    ) {
      throw blocked(ip);
    }
    const response = await undici.request(input.url, {
      dispatcher: agent,
      method: "POST",
      headers: { ...input.headers },
      body: input.body,
      signal,
      headersTimeout: RESPONSE_TIMEOUT_MS,
      bodyTimeout: RESPONSE_TIMEOUT_MS,
    });
    // The status is all that matters; never buffer what a stranger's server sends back.
    response.body.on("error", () => {});
    response.body.destroy();
    return response.statusCode;
  };

  const post = Effect.fn("PushTransport.post")((input: Parameters<typeof send>[0]) =>
    Effect.tryPromise({
      try: (signal) => send(input, signal),
      catch: (error) =>
        new PushTransportError({ reason: isBlocked(error) ? "blocked" : "unreachable" }),
    }),
  );

  return PushTransport.of({ post });
});

export const layer = Layer.effect(
  PushTransport,
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const config = yield* ServerConfig;
    const decision = insecureEndpointsDecision({
      environment,
      development: config.devUrl !== undefined,
    });
    if (decision === "allowed") {
      yield* Effect.logWarning(
        "SSRF protection for push endpoints is off: private and plain-http endpoints are accepted.",
        { variable: ALLOW_INSECURE_PUSH_ENDPOINTS_ENV },
      );
    } else if (decision === "ignored") {
      yield* Effect.logWarning(
        "Ignoring a setting that would turn off SSRF protection for push endpoints; it only applies to development runs.",
        {
          variable: ALLOW_INSECURE_PUSH_ENDPOINTS_ENV,
        },
      );
    }
    return yield* make({ allowPrivate: decision === "allowed" });
  }),
);
