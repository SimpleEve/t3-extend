// fork: `GET /api/loopback-gateway/tunnel?port=N` (research/remote-loopback-forwarding.md 3.3).
// A WebSocket whose binary frames are the bytes of one TCP connection to a loopback service of
// this machine. It is mounted on the shared router, so the main listener and the tunnel
// listener serve it with this one piece of code.
//
// Order: credentials, then limits, then ownership of the port, and only then is the connection
// dialed and upgraded; every refusal before that is a JSON HTTP response. The watch on the
// session starts before the dial, so a revocation can never leave a tunnel nobody supervises.
// The upgrade is done here with a `ws` server of our own because the transport's `Socket` writes
// without backpressure and takes no frame-size limit; the tunnel needs both.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  LOOPBACK_GATEWAY_DIAL_TIMEOUT_MS,
  LOOPBACK_GATEWAY_LIMITS,
  LOOPBACK_GATEWAY_PING_INTERVAL_MS,
  LOOPBACK_GATEWAY_PONG_TIMEOUT_MS,
  LOOPBACK_GATEWAY_PORT_PARAM,
  LOOPBACK_GATEWAY_SERVER_ERROR_STATUS,
  LOOPBACK_GATEWAY_TUNNEL_PATH,
  parseLoopbackGatewayPort,
} from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as SessionStore from "../../auth/SessionStore.ts";
import { requestUrl } from "../../requestUrl.ts";
import * as GatewayAuth from "./GatewayAuth.ts";
import * as GatewayAvailability from "./GatewayAvailability.ts";
import * as GatewayLimits from "./GatewayLimits.ts";
import * as PortAuthorizer from "./PortAuthorizer.ts";
import { refuse, type DialTarget, type GatewayRefusal } from "./PortAuthorizer.ts";

const refusalResponse = (error: GatewayRefusal) =>
  HttpServerResponse.jsonUnsafe(
    { code: error.code, message: error.reason },
    {
      status:
        LOOPBACK_GATEWAY_SERVER_ERROR_STATUS[
          error.code as keyof typeof LOOPBACK_GATEWAY_SERVER_ERROR_STATUS
        ] ?? 500,
      headers: { "cache-control": "no-store" },
    },
  );

/** Connects to the one address the port check returned. Interrupting it destroys the socket. */
const dialTarget = (target: DialTarget) =>
  Effect.callback<NodeNet.Socket, GatewayRefusal>((resume) => {
    const socket = NodeNet.connect({ host: target.host, port: target.port });
    const onError = () =>
      resume(Effect.fail(refuse("upstream-refused", "nothing accepted the connection")));
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      socket.setNoDelay(true);
      resume(Effect.succeed(socket));
    });
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(LOOPBACK_GATEWAY_DIAL_TIMEOUT_MS),
      orElse: () => Effect.fail(refuse("upstream-refused", "the connection timed out")),
    }),
  );

/**
 * Pings every interval and ends the connection once the pongs have been missing for the
 * pong timeout. There is no idle timeout: a quiet tunnel is a healthy one (Vite's HMR socket).
 */
const heartbeat = Effect.fn("LoopbackGateway.heartbeat")(function* (
  ws: Pick<NodeWS.WebSocket, "ping" | "terminate" | "on">,
) {
  let unanswered = 0;
  ws.on("pong", () => {
    unanswered = 0;
  });
  const allowed = LOOPBACK_GATEWAY_PONG_TIMEOUT_MS / LOOPBACK_GATEWAY_PING_INTERVAL_MS;
  while (true) {
    yield* Effect.sleep(Duration.millis(LOOPBACK_GATEWAY_PING_INTERVAL_MS));
    if (unanswered >= allowed) {
      ws.terminate();
      return;
    }
    unanswered += 1;
    // A socket that is not open throws; ending the tunnel is the right answer then too.
    const sent = yield* Effect.try({ try: () => ws.ping(), catch: () => "closed" as const }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!sent) {
      ws.terminate();
      return;
    }
  }
});

/**
 * Connects `tcp` and `ws` as one byte pipe with backpressure both ways, and completes once either
 * side is gone, having destroyed both. Nothing is forwarded after that.
 */
const pipeTunnel = (ws: NodeWS.WebSocket, tcp: NodeNet.Socket) =>
  Effect.callback<void>((resume) => {
    const stream = NodeWS.createWebSocketStream(ws, {
      highWaterMark: LOOPBACK_GATEWAY_LIMITS.readChunkBytes,
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      tcp.destroy();
      stream.destroy();
      ws.terminate();
      resume(Effect.void);
    };
    tcp.on("error", finish);
    stream.on("error", finish);
    ws.on("error", finish);
    // The peer going away ends the tunnel at once; the service closing first ends the stream,
    // which flushes what is queued and closes the socket, and then this fires.
    ws.on("close", finish);
    tcp.pipe(stream);
    stream.pipe(tcp);
    return Effect.sync(finish);
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const wss = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new NodeWS.WebSocketServer({
            noServer: true,
            maxPayload: LOOPBACK_GATEWAY_LIMITS.maxMessageBytes,
            perMessageDeflate: false,
          }),
      ),
      (server) => Effect.sync(() => server.close()),
    );
    const sessions = yield* SessionStore.SessionStore;
    const authorizer = yield* PortAuthorizer.PortAuthorizer;
    // Read once, here, where layers can override them; a request handler sees only the server's context.
    const limits = yield* GatewayLimits.GatewayLimits;
    const availability = yield* GatewayAvailability.currentAvailability;

    const upgrade = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.callback<NodeWS.WebSocket, GatewayRefusal>((resume) => {
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        const socket = incoming.socket;
        const onClose = () =>
          resume(Effect.fail(refuse("internal", "the connection closed before the upgrade")));
        if (socket.destroyed) return onClose();
        socket.once("close", onClose);
        wss.handleUpgrade(incoming as never, socket, Buffer.alloc(0), (ws) => {
          socket.off("close", onClose);
          // The pipe is attached a few awaits from here; a frame that comes first waits in the
          // socket (`createWebSocketStream` resumes it) instead of being emitted to no listener.
          ws.pause();
          resume(Effect.succeed(ws));
        });
      });

    const tunnel = Effect.fn("LoopbackGateway.tunnel")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* GatewayAuth.authenticateGatewayTicket(request);
      if (!availability.available) {
        return yield* refuse("discovery-disabled", "this environment does not offer the gateway");
      }
      const url = requestUrl(request);
      const port = Option.isSome(url)
        ? parseLoopbackGatewayPort(url.value.searchParams.get(LOOPBACK_GATEWAY_PORT_PARAM))
        : null;
      if (port === null) return yield* refuse("bad-request", "the port is missing or invalid");
      yield* Effect.annotateCurrentSpan({ "gateway.port": port });
      yield* limits.acquireTunnel(session.sessionId);
      // The watch starts before anything waits (the port check can sit in a collection window):
      // a revocation from here on ends the attempt at once.
      const invalidated = yield* Deferred.make<void>();
      yield* sessions.awaitInvalidation(session.sessionId, session.proofKeyThumbprint).pipe(
        // A failed read of the session counts as gone.
        Effect.ignore,
        Effect.andThen(Deferred.succeed(invalidated, undefined)),
        Effect.forkScoped,
      );
      const revoked = Deferred.await(invalidated).pipe(
        Effect.andThen(Effect.fail(refuse("unauthorized", "the session ended"))),
      );
      const target = yield* Effect.raceFirst(authorizer.authorize(port), revoked);
      // A session that ended while the port was checked gets no connection at all.
      yield* session.recheck;
      const tcp = yield* Effect.raceFirst(dialTarget(target), revoked);
      yield* Effect.addFinalizer(() => Effect.sync(() => tcp.destroy()));
      yield* session.recheck;
      const ws = yield* upgrade(request);
      yield* Effect.addFinalizer(() => Effect.sync(() => ws.terminate()));
      yield* Effect.annotateCurrentSpan({ "gateway.outcome": "open" });
      // Nothing is forwarded for a session that ended before the first byte could move.
      yield* session.recheck.pipe(Effect.onError(() => Effect.sync(() => ws.terminate())));
      yield* heartbeat(ws).pipe(Effect.forkScoped);
      yield* Effect.raceFirst(pipeTunnel(ws, tcp), Deferred.await(invalidated));
      return HttpServerResponse.empty();
    });

    return HttpRouter.add(
      "GET",
      LOOPBACK_GATEWAY_TUNNEL_PATH,
      tunnel().pipe(
        Effect.scoped,
        Effect.catchTags({
          GatewayRefusal: (error) =>
            Effect.annotateCurrentSpan({ "gateway.outcome": error.code }).pipe(
              Effect.as(refusalResponse(error)),
            ),
        }),
        // A defect answers with a fixed body; the cause is logged by name only, never the request.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => {
            const defect = Cause.squash(cause);
            return Effect.logWarning("loopback gateway: the tunnel handler failed", {
              defect: defect instanceof Error ? defect.name : "unknown",
            }).pipe(Effect.as(refusalResponse(refuse("internal", "the tunnel failed"))));
          },
        ),
      ),
    );
  }),
);
