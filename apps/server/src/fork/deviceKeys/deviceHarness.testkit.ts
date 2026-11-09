// An HTTP server with the production routes a device touches (`/oauth/token`, `/oauth/t3x-device`,
// `/api/auth/*`), real session storage and the real DeviceDirectory/DeviceKeysService, over a fake
// registry. Time is the TestClock: tests set it, then sign everything from it.
// @effect-diagnostics nodeBuiltinImport:off -- Real loopback sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, EnvironmentId, T3X_DEVICE_GRANT_TYPE } from "@t3tools/contracts";
import { computeDpopAccessTokenHash, computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import type { DpopPublicJwk } from "@t3tools/shared/dpop";
import { signAssertion } from "@t3tools/shared/forkDeviceKeys/assertion";
import { encodeInvite, redemptionOf } from "@t3tools/shared/forkDeviceKeys/invite";
import type { DeviceKeyPair } from "@t3tools/shared/forkDeviceKeys/jws";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AuthAttemptLimiter from "../../auth/AuthAttemptLimiter.ts";
import * as AuthHttp from "../../auth/http.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerHttp from "../../http.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as DeviceAssertionAuth from "./DeviceAssertionAuth.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";
import {
  FAKE_ORIGIN,
  FAKE_REGISTRY_ID,
  FakeRegistry,
  layerFakeRegistry,
} from "./registryFake.testkit.ts";

const DEV_TOKEN = "device-harness-dev-token-long-enough";
/** The TestClock is set here at the start of every test; proofs are signed from the same clock. */
export const NOW_MS = 1_800_000_000_000;
export const NOW_S = NOW_MS / 1000;

class HarnessApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

export interface HarnessResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly text: string;
  readonly json: () => Record<string, unknown>;
}

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
                json: () => decodeJson(text) as Record<string, unknown>,
              });
            });
          },
        );
        request.on("error", reject);
        request.end(input.body);
      }),
  );

export interface DpopSigner {
  readonly thumbprint: string;
  readonly proof: (input: {
    readonly method: string;
    readonly url: string;
    readonly accessToken?: string;
    readonly jti?: string;
    readonly iatOffsetSeconds?: number;
  }) => Effect.Effect<string>;
}

/** A DPoP key whose proofs are stamped with the TestClock's time. */
export const makeDpopSigner = (): DpopSigner => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  return {
    thumbprint: computeDpopJwkThumbprint(jwk),
    proof: (input) =>
      Effect.map(Clock.currentTimeMillis, (millis) => {
        const header = Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk })).toString(
          "base64url",
        );
        const payload = Buffer.from(
          JSON.stringify({
            htm: input.method,
            htu: input.url,
            jti: input.jti ?? NodeCrypto.randomBytes(16).toString("base64url"),
            iat: Math.floor(millis / 1000) + (input.iatOffsetSeconds ?? 0),
            ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
          }),
        ).toString("base64url");
        const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url");
        return `${header}.${payload}.${signature}`;
      }),
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
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-device-harness-" })));

/** Steers what the directory's session store does, so a test can hold a reconcile mid-revoke. */
export interface RevokeHooks {
  beforeRevoke: Effect.Effect<void>;
  /** Runs inside the pass route right after it reads the list, before it judges the pass. */
  afterStateRead: Effect.Effect<void>;
  /** Runs inside the pass route as it asks for the gate. */
  onGateRequested: Effect.Effect<void>;
  /** Runs first in a global middleware, standing in for the server's readiness gate. */
  ready: Effect.Effect<void>;
}

export class Harness extends Context.Service<
  Harness,
  {
    readonly port: number;
    readonly origin: string;
    readonly environmentId: string;
    readonly limiterClients: Array<string>;
    readonly hooks: RevokeHooks;
  }
>()("t3/fork/deviceKeys/deviceHarness.testkit/Harness") {}

export const layerHarness = Layer.unwrap(
  Effect.sync(() => {
    const limiterClients: Array<string> = [];
    const hooks: RevokeHooks = {
      beforeRevoke: Effect.void,
      afterStateRead: Effect.void,
      onGateRequested: Effect.void,
      ready: Effect.void,
    };

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

    const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
      Layer.provide(ManagedPolicy.layerTest()),
      // Visible, so a test can write the database the way another process would.
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(layerConfig),
    );
    // The directory revokes through a decorated store; everything else sees the real one.
    const layerHookedSessions = Layer.effect(
      SessionStore.SessionStore,
      Effect.gen(function* () {
        const real = yield* SessionStore.SessionStore;
        return SessionStore.SessionStore.of({
          ...real,
          revoke: (sessionId) => hooks.beforeRevoke.pipe(Effect.andThen(real.revoke(sessionId))),
        });
      }),
    );
    const layerDirectory = DeviceDirectory.layer.pipe(
      Layer.provide(layerHookedSessions),
      Layer.provide(DeviceIdentity.layer),
    );
    // The route sees the directory through hooks; the service and the sync loop use the real one.
    const layerRouteDirectory = Layer.effect(
      DeviceDirectory.DeviceDirectory,
      Effect.gen(function* () {
        const real = yield* DeviceDirectory.DeviceDirectory;
        return DeviceDirectory.DeviceDirectory.of({
          ...real,
          state: real.state.pipe(Effect.tap(() => hooks.afterStateRead)),
          withGate: (effect) => hooks.onGateRequested.pipe(Effect.andThen(real.withGate(effect))),
        });
      }),
    );
    const layerReadiness = HttpRouter.middleware(
      (httpEffect) => Effect.suspend(() => hooks.ready).pipe(Effect.andThen(httpEffect)),
      { global: true },
    );
    const layerDevices = DeviceKeysService.layer.pipe(
      Layer.provideMerge(layerDirectory),
      Layer.provideMerge(DeviceIdentity.layer),
      Layer.provideMerge(layerFakeRegistry),
    );

    const layerRoutes = Layer.mergeAll(
      HttpApiBuilder.layer(HarnessApi).pipe(
        Layer.provide(AuthHttp.layer),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
      ),
      DeviceAssertionAuth.layerRoute.pipe(Layer.provide(layerRouteDirectory)),
      HttpRouter.add(
        "GET",
        "/test/ws-auth",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const session = yield* auth.authenticateWebSocketUpgrade(request, "rpc").pipe(
            // Same mapping the real /ws route applies.
            Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
              AuthHttp.failEnvironmentAuthInvalid(
                EnvironmentAuth.serverAuthCredentialReason(error),
                EnvironmentAuth.serverAuthDpopFailureReason(error),
              ),
            ),
          );
          return HttpServerResponse.jsonUnsafe({ sessionId: session.sessionId });
        }),
      ),
    ).pipe(
      Layer.provide(layerReadiness),
      Layer.provide(AuthAttemptLimiter.middleware.pipe(Layer.provide(layerLimiter))),
      Layer.provide(ServerHttp.layerBrowserApiCors),
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

    return Layer.effect(
      Harness,
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const address = server.address;
        if (!("port" in address)) return yield* Effect.die("Expected a TCP address.");
        return Harness.of({
          port: address.port,
          origin: `http://127.0.0.1:${address.port}`,
          environmentId: yield* identity.getEnvironmentId,
          limiterClients,
          hooks,
        });
      }),
    ).pipe(
      Layer.provideMerge(
        HttpRouter.serve(layerRoutes, { disableLogger: true, disableListenLog: true }),
      ),
      Layer.provideMerge(layerDevices),
      Layer.provideMerge(layerEnvironmentAuth),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provide(layerConfig),
      Layer.provideMerge(layerMainServer),
      Layer.provide(layerPlatform),
    );
  }),
);

/** The invite the fake registry accepts, shaped like the real one. */
export const fakeInvite = (
  kind: "computer" | "phone" | "any" = "computer",
  expiresAt: number = NOW_S + 900,
) => {
  const invite = {
    origin: FAKE_ORIGIN,
    registryId: FAKE_REGISTRY_ID,
    id: "AAAAAAAAAAA",
    secret: "BBBBBBBBBBBBBBBBBBBBBB",
    kind,
    expiresAt,
  } as const;
  return { invite, text: encodeInvite(invite), redemption: redemptionOf(invite) };
};

/** Joins this computer to the fake registry and syncs once, as the desktop app would. */
export const joinThisComputer = Effect.fn("joinThisComputer")(function* (name = "Studio") {
  const fake = yield* FakeRegistry;
  const service = yield* DeviceKeysService.DeviceKeysService;
  const invite = fakeInvite();
  fake.state.invite = invite.redemption;
  const status = yield* service.join({ invite: invite.text, name });
  return status;
});

export interface PassOptions {
  readonly audience: string;
  readonly dpop: DpopSigner;
  readonly iat?: number;
  readonly lifetimeSeconds?: number;
  readonly registryId?: string;
  readonly jti?: string;
}

/** A pass the way a device would sign it for this harness's computer. */
export const passFor = (device: Pick<DeviceKeyPair, "privateKey" | "id">, options: PassOptions) =>
  Effect.map(
    Clock.currentTimeMillis,
    (millis) =>
      signAssertion({
        privateKey: device.privateKey,
        deviceId: device.id,
        audienceEnvironmentId: options.audience,
        registryId: options.registryId ?? FAKE_REGISTRY_ID,
        dpopThumbprint: options.dpop.thumbprint,
        iat: options.iat ?? Math.floor(millis / 1000),
        ...(options.lifetimeSeconds === undefined
          ? {}
          : { lifetimeSeconds: options.lifetimeSeconds }),
        ...(options.jti === undefined ? {} : { jti: options.jti }),
      }).assertion,
  );

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

/** POST /oauth/t3x-device with a DPoP proof for the harness's own origin. */
export interface ExchangePassInput {
  readonly port: number;
  readonly origin: string;
  readonly assertion: string;
  readonly dpop: DpopSigner;
  readonly dpopJti?: string;
  readonly dpopIatOffsetSeconds?: number;
  readonly dpopMethod?: string;
  readonly dpopUrl?: string;
  readonly scope?: string;
  readonly omitDpop?: boolean;
  readonly extraHeaders?: Record<string, string>;
  readonly grantType?: string;
  readonly rawBody?: string;
}

export const exchangePass = Effect.fn("exchangePass")(function* (input: ExchangePassInput) {
  const proof = yield* input.dpop.proof({
    method: input.dpopMethod ?? "POST",
    url: input.dpopUrl ?? `${input.origin}/oauth/t3x-device`,
    ...(input.dpopJti === undefined ? {} : { jti: input.dpopJti }),
    ...(input.dpopIatOffsetSeconds === undefined
      ? {}
      : { iatOffsetSeconds: input.dpopIatOffsetSeconds }),
  });
  const body =
    input.rawBody ??
    form({
      grant_type: input.grantType ?? T3X_DEVICE_GRANT_TYPE,
      assertion: input.assertion,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    });
  return yield* send(input.port, {
    method: "POST",
    path: "/oauth/t3x-device",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
      ...(input.omitDpop === true ? {} : { dpop: proof }),
      ...input.extraHeaders,
    },
    body,
  });
});

/** An authenticated POST (a WebSocket ticket): a revoked or unknown token gets 401. */
export const ticketRequest = Effect.fn("ticketRequest")(function* (input: {
  readonly port: number;
  readonly origin: string;
  readonly token: string;
  readonly dpop: DpopSigner;
}) {
  const path = "/api/auth/websocket-ticket/rpc";
  return yield* send(input.port, {
    method: "POST",
    path,
    headers: {
      authorization: `DPoP ${input.token}`,
      dpop: yield* input.dpop.proof({
        method: "POST",
        url: `${input.origin}${path}`,
        accessToken: input.token,
      }),
    },
  });
});

/** POST /oauth/token for the bootstrap credential, with or without DPoP: the comparison baseline. */
export const exchangeBootstrap = Effect.fn("exchangeBootstrap")(function* (input: {
  readonly port: number;
  readonly origin: string;
  readonly dpop: DpopSigner;
  readonly credential?: string;
  readonly dpopJti?: string;
  readonly dpopIatOffsetSeconds?: number;
  readonly omitDpop?: boolean;
  readonly dpopMethod?: string;
  readonly dpopUrl?: string;
  readonly rawBody?: string;
  readonly extraHeaders?: Record<string, string>;
}) {
  const proof = yield* input.dpop.proof({
    method: input.dpopMethod ?? "POST",
    url: input.dpopUrl ?? `${input.origin}/oauth/token`,
    ...(input.dpopJti === undefined ? {} : { jti: input.dpopJti }),
    ...(input.dpopIatOffsetSeconds === undefined
      ? {}
      : { iatOffsetSeconds: input.dpopIatOffsetSeconds }),
  });
  const body =
    input.rawBody ??
    form({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: input.credential ?? DEV_TOKEN,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
  return yield* send(input.port, {
    method: "POST",
    path: "/oauth/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
      ...(input.omitDpop === true ? {} : { dpop: proof }),
      ...input.extraHeaders,
    },
    body,
  });
});

const memorySecrets = Layer.unwrap(
  Effect.sync(() => {
    const files = new Map<string, Uint8Array>();
    return Layer.succeed(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: (name) => Effect.sync(() => Option.fromNullishOr(files.get(name))),
        set: (name, value) => Effect.sync(() => void files.set(name, value)),
        create: (name, value) => Effect.sync(() => void files.set(name, value)),
        getOrCreateRandom: () => Effect.die("unused"),
        remove: (name) => Effect.sync(() => void files.delete(name)),
      }),
    );
  }),
);

/**
 * The device services over in-memory storage and the given registry layer, without HTTP or sessions.
 * For tests whose every await has to belong to the clock (the sync loop) or that talk to a real registry.
 */
export const layerMemoryWith = <ROut, E, R>(registry: Layer.Layer<ROut, E, R>) =>
  DeviceKeysService.layer.pipe(
    Layer.provideMerge(DeviceDirectory.layer),
    Layer.provideMerge(DeviceIdentity.layer),
    Layer.provideMerge(registry),
    Layer.provideMerge(memorySecrets),
    Layer.provideMerge(
      // Only the two calls the directory makes on it.
      Layer.succeed(SessionStore.SessionStore, {
        listActive: () => Effect.succeed([]),
        revoke: () => Effect.succeed(false),
        announceRevoked: () => Effect.succeed(0),
      } as unknown as SessionStore.SessionStore["Service"]),
    ),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-memory")),
      }),
    ),
  );
