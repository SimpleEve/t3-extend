// fork: frpc's dedicated loopback listener (research/self-host-device-keys.md §3.11).
// The signal that a request came through our own tunnel is the socket it arrived on, which a
// peer cannot choose; no header or Host value carries that trust.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Headers from "effect/http/Headers";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  guardHttpResponseWriteErrors,
  rejectRequestsUntilServing,
} from "../../httpResponseErrorGuard.ts";

/** The tunnel's public origin, `https://<subdomain>.<domain>[:port]`; none until this machine has joined. */
export class TunnelOrigin extends Context.Service<
  TunnelOrigin,
  { readonly current: Effect.Effect<Option.Option<string>> }
>()("t3/fork/deviceKeys/TunnelListener/TunnelOrigin") {}

/** Where the listener ended up; frpc's `localPort` points here. */
export class TunnelListener extends Context.Service<
  TunnelListener,
  { readonly port: Effect.Effect<number> }
>()("t3/fork/deviceKeys/TunnelListener") {}

/** Used for every tunnel client whose address frps did not pass on as a literal IP. */
const TUNNEL_UNKNOWN_CLIENT = "tunnel-unknown";

const DROPPED_HEADERS = new Set(["forwarded", "x-real-ip", "x-t3x-client-ip"]);

/**
 * Makes a tunnel request look as if the public HTTPS origin had received it directly: `Host`
 * and the forwarded host/proto name the tunnel origin, and `X-Forwarded-For` holds only the
 * client address Caddy put in `X-T3x-Client-IP` (or a shared bucket name when it is not an IP).
 */
const rewriteTunnelRequest = (
  request: HttpServerRequest.HttpServerRequest,
  tunnelOrigin: string,
): HttpServerRequest.HttpServerRequest => {
  const clientIp = request.headers["x-t3x-client-ip"]?.trim();
  let headers = Headers.empty;
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_HEADERS.has(name) || name.startsWith("x-forwarded-")) continue;
    headers = Headers.set(headers, name, value);
  }
  const { host } = new URL(tunnelOrigin);
  headers = Headers.set(headers, "host", host);
  headers = Headers.set(headers, "x-forwarded-host", host);
  headers = Headers.set(headers, "x-forwarded-proto", "https");
  headers = Headers.set(
    headers,
    "x-forwarded-for",
    clientIp !== undefined && NodeNet.isIP(clientIp) !== 0 ? clientIp : TUNNEL_UNKNOWN_CLIENT,
  );
  return request.modify({ headers });
};

const tunnelNotReady = HttpServerResponse.jsonUnsafe(
  { error: "tunnel_not_ready" },
  { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
);

/**
 * Serves the application a second time on a loopback-only, OS-assigned port. `served` must be
 * `HttpRouter.serve(...)`: the router it built is reused (building the routes again would give a
 * second copy of every service), and the handler comes from the router on the first request,
 * after every global middleware has registered.
 */
export const withTunnel = <A, E, R>(served: Layer.Layer<A, E, R>) =>
  Layer.effect(
    TunnelListener,
    Effect.gen(function* () {
      // Needed for its request-time effect only: `serve` outputs its whole context, router included.
      const router = yield* HttpRouter.HttpRouter;
      const origin = yield* TunnelOrigin;
      const port = yield* Deferred.make<number>();
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- asHttpEffect types its failures as unknown; the server turns them into responses.
      const handler = yield* Effect.cached(Effect.sync(() => router.asHttpEffect()));
      const tunnelServer = yield* NodeHttpServer.make(
        () => rejectRequestsUntilServing(guardHttpResponseWriteErrors(NodeHttp.createServer())),
        {
          host: "127.0.0.1",
          port: 0,
          gracefulShutdownTimeout: 0,
          websocket: { perMessageDeflate: true },
        },
      );
      const address = tunnelServer.address;
      if (!("port" in address)) {
        return yield* Effect.die("The tunnel listener must bind a TCP port.");
      }
      yield* Deferred.succeed(port, address.port);
      yield* Effect.logInfo(`Tunnel listener on 127.0.0.1:${address.port}`);
      const app = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const tunnelOrigin = yield* origin.current;
        if (Option.isNone(tunnelOrigin)) return tunnelNotReady;
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- see above.
        return yield* (yield* handler).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            rewriteTunnelRequest(request, tunnelOrigin.value),
          ),
        );
      });
      // `serveEffect` captures this fiber's context for requests, as `HttpRouter.serve` does.
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- see above.
      yield* HttpServer.serveEffect(app).pipe(
        Effect.provideService(HttpServer.HttpServer, tunnelServer),
      );
      return TunnelListener.of({ port: Deferred.await(port) });
    }),
  ).pipe(Layer.provideMerge(served as Layer.Layer<A | HttpRouter.HttpRouter, E, R>));
