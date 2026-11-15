// A real two-listener server for the device-key tests: the routes and global middleware are the
// production ones where they are importable, composed the way `server.ts` composes them.
// @effect-diagnostics nodeBuiltinImport:off -- Real loopback sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { computeDpopAccessTokenHash, computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import type { DpopPublicJwk } from "@t3tools/shared/dpop";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Socket from "effect/socket/Socket";

import * as AuthAttemptLimiter from "../../auth/AuthAttemptLimiter.ts";
import { requestUrl } from "../../requestUrl.ts";
import * as AuthHttp from "../../auth/http.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../auth/McpOAuth.ts";
import * as CloudLink from "../../cloud/CloudLink.ts";
import * as McpOAuthHttp from "../../auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerHttp from "../../http.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as TunnelListener from "./TunnelListener.ts";

export const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
export const TUNNEL_ORIGIN = "https://laptop.t3.example.test";

class HarnessApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface HarnessResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly text: string;
  readonly json: () => unknown;
}

/** Plain `node:http`, so tests control `Host` and every forwarding header exactly. */
export const send = (
  port: number,
  input: {
    readonly method?: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) =>
  Effect.promise(
    () =>
      new Promise<HarnessResponse>((resolve, reject) => {
        const request = NodeHttp.request(
          {
            host: "127.0.0.1",
            port,
            method: input.method ?? "GET",
            path: input.path,
            headers: input.headers,
          },
          (response) => {
            const chunks: Array<Buffer> = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                text,
                json: () => decodeJson(text),
              });
            });
          },
        );
        request.on("error", reject);
        request.end(input.body);
      }),
  );

export interface DpopSigner {
  readonly jwk: DpopPublicJwk;
  readonly thumbprint: string;
  readonly proof: (input: {
    readonly method: string;
    readonly url: string;
    readonly accessToken?: string;
    readonly iat: number;
    readonly jti?: string;
  }) => string;
}

export const makeDpopSigner = (): DpopSigner => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  return {
    jwk,
    thumbprint: computeDpopJwkThumbprint(jwk),
    proof: (input) => {
      const header = Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({
          htm: input.method,
          htu: input.url,
          jti: input.jti ?? NodeCrypto.randomBytes(16).toString("base64url"),
          iat: input.iat,
          ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
        }),
      ).toString("base64url");
      const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
  };
};

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
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tunnel-harness-" })));

/** Everything the harness lets a test observe or steer. */
export class Harness extends Context.Service<
  Harness,
  {
    readonly mainPort: number;
    readonly tunnelPort: number;
    /** Request paths seen by the stand-in global middleware, in order. */
    readonly seen: Array<string>;
    /** Every client key the real `AuthAttemptLimiter` middleware asked about. */
    readonly limiterClients: Array<string>;
    readonly setTunnelOrigin: (origin: Option.Option<string>) => void;
  }
>()("t3/fork/deviceKeys/tunnelHarness.testkit/Harness") {}

export const layerHarness = Layer.unwrap(
  Effect.sync(() => {
    const seen: Array<string> = [];
    const limiterClients: Array<string> = [];
    let tunnelOrigin: Option.Option<string> = Option.some(TUNNEL_ORIGIN);

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
    // Stands in for the readiness gate, which needs the whole runtime.
    const layerSeen = HttpRouter.middleware(
      (httpEffect) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
          seen.push(request.url);
          return httpEffect;
        }),
      { global: true },
    );

    const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
      Layer.provide(ManagedPolicy.layerTest()),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(layerConfig),
    );

    const layerTestRoutes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/test/inspect",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return HttpServerResponse.jsonUnsafe({
            url: Option.getOrUndefined(Option.map(requestUrl(request), String)),
            headers: request.headers,
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/test/ws",
        Effect.scoped(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const auth = yield* EnvironmentAuth.EnvironmentAuth;
            const session = yield* auth.authenticateWebSocketUpgrade(request, "rpc");
            const socket = yield* request.upgrade;
            // Taking the reader performs the handshake; the writer waits for it.
            yield* socket.reader;
            const writer = yield* socket.writer;
            yield* writer.write(session.sessionId);
            yield* writer.write(new Socket.CloseEvent(1000, "done"));
            return HttpServerResponse.empty();
          }),
        ),
      ),
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
      layerTestRoutes,
    ).pipe(
      Layer.provide(layerSeen),
      Layer.provide(AuthAttemptLimiter.middleware.pipe(Layer.provide(layerLimiter))),
      Layer.provide(ServerHttp.layerBrowserApiCors),
      Layer.provide(ServerHttp.layerHttpCompression),
      Layer.provide(layerConfig),
    );

    const layerPlatform = HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    );
    const layerMainServer = NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
    });
    const layerTunnelOrigin = Layer.succeed(TunnelListener.TunnelOrigin, {
      current: Effect.sync(() => tunnelOrigin),
    });

    return Layer.effect(
      Harness,
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const tunnel = yield* TunnelListener.TunnelListener;
        const address = server.address;
        if (!("port" in address)) return yield* Effect.die("Expected a TCP address.");
        return Harness.of({
          mainPort: address.port,
          tunnelPort: yield* tunnel.port,
          seen,
          limiterClients,
          setTunnelOrigin: (origin) => {
            tunnelOrigin = origin;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(
        TunnelListener.withTunnel(
          HttpRouter.serve(layerRoutes, { disableLogger: true, disableListenLog: true }),
        ),
      ),
      Layer.provide(layerTunnelOrigin),
      Layer.provide(layerEnvironmentAuth),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(layerConfig),
      Layer.provideMerge(layerMainServer),
      Layer.provide(layerPlatform),
    );
  }),
);
