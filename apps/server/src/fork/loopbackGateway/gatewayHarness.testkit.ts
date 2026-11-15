// A real two-listener server with the gateway's tunnel route on it: the production auth routes,
// the production session store and rate limiter, and the production tunnel route over a fake
// port authorizer (the real checks have their own tests). Tests open tunnels with a real `ws`
// client and real loopback services.
// @effect-diagnostics nodeBuiltinImport:off -- Real loopback sockets.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  EnvironmentHttpApi,
  LOOPBACK_GATEWAY_TICKET_AUDIENCE,
  type AuthEnvironmentScope,
  type AuthWebSocketTicketUse,
} from "@t3tools/contracts";
import {
  LOOPBACK_GATEWAY_LIMITS,
  formatLoopbackGatewayAuthorization,
} from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/http/Etag";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as AuthAttemptLimiter from "../../auth/AuthAttemptLimiter.ts";
import * as AuthHttp from "../../auth/http.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../auth/McpOAuth.ts";
import * as CloudLink from "../../cloud/CloudLink.ts";
import * as McpOAuthHttp from "../../auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerHttp from "../../http.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as TunnelListener from "../deviceKeys/TunnelListener.ts";
import * as GatewayAvailability from "./GatewayAvailability.ts";
import * as GatewayLimits from "./GatewayLimits.ts";
import * as PortAuthorizer from "./PortAuthorizer.ts";
import * as TunnelRoute from "./TunnelRoute.ts";

const DEV_TOKEN = "gateway-harness-dev-token";
const TUNNEL_ORIGIN = "https://laptop.t3.example.test";

class HarnessApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-gateway-harness-" })));

export interface UpgradeHold {
  /** Done once the route is stalled, with the server's side of the upgraded connection. */
  readonly reached: Deferred.Deferred<NodeNet.Socket>;
  readonly release: () => void;
}

export type AuthorizeImpl = (
  port: number,
) => Effect.Effect<PortAuthorizer.DialTarget, PortAuthorizer.GatewayRefusal>;

export class Gateway extends Context.Service<
  Gateway,
  {
    readonly mainPort: number;
    readonly tunnelPort: number;
    readonly sessions: SessionStore.SessionStore["Service"];
    readonly authorizeCalls: Array<number>;
    /** Every client key the production `AuthAttemptLimiter` was asked about. */
    readonly limiterClients: Array<string>;
    readonly setAuthorize: (impl: AuthorizeImpl) => void;
    readonly setAvailable: (value: boolean) => void;
    /**
     * Stalls the route's first session check after a tunnel's upgrade response was written, the
     * gap before its byte pipe is attached. Arm it before opening the tunnel.
     */
    readonly holdAfterUpgrade: () => UpgradeHold;
    /** Every request path the global stand-in middleware saw. */
    readonly seen: Array<string>;
  }
>()("t3/fork/loopbackGateway/gatewayHarness.testkit/Gateway") {}

/** Everything the logger and the tracer were given while a harness ran. */
export interface Capture {
  readonly logs: Array<string>;
  readonly spans: Array<Tracer.NativeSpan>;
}

const captureLayers = (capture: Capture) =>
  Layer.mergeAll(
    Logger.layer([
      Logger.make((entry) => {
        const annotations = Object.entries(entry.fiber.getRef(References.CurrentLogAnnotations));
        capture.logs.push(
          JSON.stringify({
            message: entry.message,
            cause: Cause.isCause(entry.cause) ? Cause.pretty(entry.cause) : null,
            annotations,
          }),
        );
      }),
    ]),
    Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          capture.spans.push(span);
          return span;
        },
      }),
    ),
  );

export const makeLayerGateway = (
  options: {
    readonly logWsEvents?: boolean;
    /** Records what route handlers and their middleware log and trace. */
    readonly capture?: Capture;
    readonly limits?: { readonly [K in keyof typeof LOOPBACK_GATEWAY_LIMITS]?: number };
  } = {},
) =>
  Layer.unwrap(
    Effect.sync(() => {
      const authorizeCalls: Array<number> = [];
      const limiterClients: Array<string> = [];
      const seen: Array<string> = [];
      let authorizeImpl: AuthorizeImpl = (port) =>
        Effect.succeed({ host: "127.0.0.1", port, pid: process.pid });
      let available = true;
      // The server's side of every connection, and the stall `holdAfterUpgrade` arms.
      const serverSockets = new Set<NodeNet.Socket>();
      let hold:
        | { readonly gate: Deferred.Deferred<void>; readonly reached: UpgradeHold["reached"] }
        | undefined;

      const layerLimiter = Layer.effect(
        AuthAttemptLimiter.AuthAttemptLimiter,
        Effect.gen(function* () {
          const real = yield* AuthAttemptLimiter.make();
          return AuthAttemptLimiter.AuthAttemptLimiter.of({
            check: (client) => {
              limiterClients.push(client);
              return real.check(client);
            },
            recordFailure: real.recordFailure,
          });
        }),
      );
      const layerCapture =
        options.capture === undefined
          ? Layer.empty
          : HttpRouter.middleware(
              (httpEffect) => httpEffect.pipe(Effect.provide(captureLayers(options.capture!))),
              { global: true },
            );
      const layerSeen = HttpRouter.middleware(
        (httpEffect) =>
          Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
            seen.push(request.url);
            return httpEffect;
          }),
        { global: true },
      );

      const layerAuth = EnvironmentAuth.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
      );

      // What the route and its handlers read as the session store: the real one, except that the
      // first token check after an upgrade response has gone out waits while a hold is armed.
      const layerGatedSessions = Layer.effect(
        SessionStore.SessionStore,
        Effect.gen(function* () {
          const real = yield* SessionStore.SessionStore;
          return SessionStore.SessionStore.of({
            ...real,
            verifyWebSocketToken: (token) =>
              Effect.gen(function* () {
                const armed = hold;
                const upgraded = [...serverSockets].find(
                  (socket) => !socket.destroyed && socket.bytesWritten > 0,
                );
                if (armed !== undefined && upgraded !== undefined) {
                  hold = undefined;
                  yield* Deferred.succeed(armed.reached, upgraded);
                  yield* Deferred.await(armed.gate);
                }
                return yield* real.verifyWebSocketToken(token);
              }),
          });
        }),
      );

      const layerPortAuthorizer = Layer.succeed(
        PortAuthorizer.PortAuthorizer,
        PortAuthorizer.PortAuthorizer.of({
          authorize: (port) => {
            authorizeCalls.push(port);
            return authorizeImpl(port);
          },
        }),
      );
      const layerAvailability = Layer.succeed(GatewayAvailability.GatewayAvailabilityOverride, {
        get available() {
          return available;
        },
        get reason() {
          return "discovery-disabled" as const;
        },
      } as GatewayAvailability.GatewayAvailabilityResult);
      const layerLimits = Layer.succeed(
        GatewayLimits.GatewayLimits,
        GatewayLimits.makeGatewayLimits(options.limits),
      );

      const upgradeAuthRoute = (use: "rpc" | "media") =>
        HttpRouter.add(
          "GET",
          `/test/upgrade-auth/${use}`,
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const auth = yield* EnvironmentAuth.EnvironmentAuth;
            return yield* auth.authenticateWebSocketUpgrade(request, use).pipe(
              Effect.map((session) =>
                HttpServerResponse.jsonUnsafe({ ok: true, sessionId: session.sessionId }),
              ),
              Effect.catchTags({
                ServerAuthInvalidCredentialError: (error) =>
                  Effect.succeed(
                    HttpServerResponse.jsonUnsafe(
                      {
                        ok: false,
                        diagnostic: error.diagnostic ?? null,
                        dpopFailureReason: error.dpopFailureReason ?? null,
                      },
                      { status: 401 },
                    ),
                  ),
              }),
            );
          }),
        );
      const layerUpgradeAuthRoutes = Layer.mergeAll(
        upgradeAuthRoute("rpc"),
        upgradeAuthRoute("media"),
      );

      const stubMcpOAuth = Layer.succeed(McpOAuth.McpOAuth, {} as McpOAuth.McpOAuth["Service"]);
      const layerRoutes = Layer.mergeAll(
        HttpApiBuilder.layer(HarnessApi).pipe(
          Layer.provide(AuthHttp.layer),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
          Layer.provide(McpOAuthHttp.layer),
          Layer.provide(Layer.succeed(CloudLink.CloudLink, {} as CloudLink.CloudLink["Service"])),
          Layer.provide(ServerEnvironment.layerIdentity.pipe(Layer.provide(layerConfig))),
          Layer.provide(stubMcpOAuth),
        ),
        layerUpgradeAuthRoutes,
        TunnelRoute.layer.pipe(
          Layer.provide(layerPortAuthorizer),
          Layer.provide(layerLimits),
          Layer.provide(layerAvailability),
        ),
      ).pipe(
        Layer.provide(layerSeen),
        Layer.provide(layerCapture),
        Layer.provide(AuthAttemptLimiter.middleware.pipe(Layer.provide(layerLimiter))),
        Layer.provide(ServerHttp.layerBrowserApiCors),
        Layer.provide(ServerHttp.layerHttpCompression),
        Layer.provide(layerConfig),
      );

      const layerPlatform = HttpPlatform.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
        Layer.provideMerge(Etag.layerWeak),
      );
      const layerMainServer = NodeHttpServer.layer(
        () => {
          const server = NodeHttp.createServer();
          server.on("connection", (socket) => {
            serverSockets.add(socket);
            socket.once("close", () => serverSockets.delete(socket));
          });
          return server;
        },
        { host: "127.0.0.1", port: 0 },
      );
      const layerTunnelOrigin = Layer.succeed(TunnelListener.TunnelOrigin, {
        current: Effect.succeedSome(TUNNEL_ORIGIN),
      });

      return Layer.effect(
        Gateway,
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const tunnel = yield* TunnelListener.TunnelListener;
          const sessions = yield* SessionStore.SessionStore;
          const address = server.address;
          if (!("port" in address)) return yield* Effect.die("Expected a TCP address.");
          return Gateway.of({
            mainPort: address.port,
            tunnelPort: yield* tunnel.port,
            sessions,
            authorizeCalls,
            limiterClients,
            seen,
            setAuthorize: (impl) => {
              authorizeImpl = impl;
            },
            setAvailable: (value) => {
              available = value;
            },
            holdAfterUpgrade: () => {
              const gate = Deferred.makeUnsafe<void>();
              const reached = Deferred.makeUnsafe<NodeNet.Socket>();
              hold = { gate, reached };
              return { reached, release: () => Deferred.doneUnsafe(gate, Effect.void) };
            },
          });
        }),
      ).pipe(
        Layer.provideMerge(
          TunnelListener.withTunnel(
            HttpRouter.serve(layerRoutes, {
              disableLogger: options.logWsEvents !== true,
              disableListenLog: true,
            }).pipe(
              // The request logger runs outside the routes, in the server's own context.
              Layer.provide(
                options.capture === undefined ? Layer.empty : captureLayers(options.capture),
              ),
              Layer.provide(layerGatedSessions),
            ),
          ),
        ),
        Layer.provide(layerTunnelOrigin),
        Layer.provideMerge(layerAuth),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(layerConfig),
        Layer.provideMerge(layerMainServer),
        Layer.provide(layerPlatform),
      );
    }),
  );

export const layerGateway = makeLayerGateway();

export const GATEWAY_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
];

/** A session and a ticket for it. `audience: undefined` signs a ticket with none (the legacy kind). */
export const issueSessionTicket = Effect.fn("issueSessionTicket")(function* (
  options: {
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly audience?: AuthWebSocketTicketUse | null;
    readonly subject?: string;
    readonly proofKeyThumbprint?: string;
    readonly ticketTtl?: import("effect/Duration").Duration;
    readonly sessionTtl?: import("effect/Duration").Duration;
  } = {},
) {
  const { sessions } = yield* Gateway;
  const session = yield* sessions.issue({
    subject: options.subject ?? "tunnel-test",
    method:
      options.proofKeyThumbprint === undefined ? "browser-session-cookie" : "dpop-access-token",
    scopes: options.scopes ?? GATEWAY_SCOPES,
    ...(options.sessionTtl === undefined ? {} : { ttl: options.sessionTtl }),
    ...(options.proofKeyThumbprint === undefined
      ? {}
      : { proofKeyThumbprint: options.proofKeyThumbprint }),
    client: { label: "tunnel test", deviceType: "desktop" },
  });
  const audience =
    options.audience === undefined ? LOOPBACK_GATEWAY_TICKET_AUDIENCE : options.audience;
  const issued = yield* sessions.issueWebSocketToken(session.sessionId, {
    ...(audience === null ? {} : { audience }),
    ...(options.proofKeyThumbprint === undefined
      ? {}
      : { proofKeyThumbprint: options.proofKeyThumbprint }),
    ...(options.ticketTtl === undefined ? {} : { ttl: options.ticketTtl }),
  });
  return { session, ticket: issued.token };
});

export type TunnelAttempt =
  | { readonly _tag: "open"; readonly ws: NodeWS.WebSocket }
  | {
      readonly _tag: "refused";
      readonly status: number;
      readonly body: unknown;
      readonly text: string;
    };

/** Opens a tunnel with a real `ws` client; HTTP refusals come back as `refused`. */
export const openTunnel = (
  port: number,
  input: {
    readonly ticket?: string | undefined;
    readonly authorization?: string | undefined;
    readonly query?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly path?: string;
    readonly maxPayload?: number;
  },
) =>
  Effect.promise(
    () =>
      new Promise<TunnelAttempt>((resolve, reject) => {
        const authorization =
          input.authorization ??
          (input.ticket === undefined
            ? undefined
            : formatLoopbackGatewayAuthorization(input.ticket));
        const ws = new NodeWS.WebSocket(
          `ws://127.0.0.1:${port}${input.path ?? "/api/loopback-gateway/tunnel"}?${input.query ?? "port=1"}`,
          {
            headers: {
              ...(authorization === undefined ? {} : { authorization }),
              ...input.headers,
            },
            followRedirects: false,
            maxPayload: input.maxPayload ?? 64 * 1024 * 1024,
          },
        );
        ws.once("open", () => resolve({ _tag: "open", ws }));
        ws.once("unexpected-response", (_request, response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = text;
            try {
              body = JSON.parse(text);
            } catch {}
            resolve({ _tag: "refused", status: response.statusCode ?? 0, body, text });
          });
        });
        ws.once("error", reject);
      }),
  );

/** A real loopback TCP service. `onConnection` gets each accepted socket. */
export const listenLoopback = (onConnection: (socket: NodeNet.Socket) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly port: number; readonly server: NodeNet.Server }>(
          (resolve, reject) => {
            const server = NodeNet.createServer(onConnection);
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              resolve({ port: (server.address() as NodeNet.AddressInfo).port, server });
            });
          },
        ),
    ),
    ({ server }) => Effect.sync(() => server.close()),
  );
