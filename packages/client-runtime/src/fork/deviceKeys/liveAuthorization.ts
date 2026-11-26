// fork: the real `DeviceKeyAuthorization` (design Q2, Q10, 3.5). Platform code supplies the two
// things that differ between a desktop and a phone, the device list and a way to sign a pass; the
// order of checks, the pass exchange and the session cache are the same everywhere.
import {
  AuthAccessTokenResult,
  type AuthClientPresentationMetadata,
  T3X_DEVICE_GRANT_TYPE,
  T3X_DEVICE_TOKEN_PATH,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { resolveRemoteDpopWebSocketConnectionUrl } from "../../authorization/remote.ts";
import type { AuthorizedRemoteEnvironment } from "../../authorization/service.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "../../connection/errors.ts";
import {
  ConnectionBlockedError,
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  type ConnectionAttemptError,
} from "../../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../../environment/descriptor.ts";
import { environmentEndpointUrl } from "../../environment/endpoint.ts";
import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
} from "../../rpc/http.ts";
import type { ManagedRelayDpopSigner } from "../../relay/managedRelay.ts";
import {
  deviceConnectionBlocked,
  deviceConnectionTransient,
  type DeviceEnvironmentIndexShape,
  type DeviceKeyAuthorizationShape,
  type DeviceRoute,
} from "./DeviceKeyAuthorization.ts";
import { judgeRoute, verdictError, type DeviceDirectoryView } from "./discovery.ts";

/** About 75 seconds in all: the other computer may not have synced this device yet. */
export const DEVICE_UNKNOWN_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 14_000];
const PASS_REQUEST_TIMEOUT_MS = 10_000;
const isRemoteEnvironmentAuthTimeoutError = Schema.is(RemoteEnvironmentAuthTimeoutError);

/** The platform half of device authorization. */
export interface DeviceAuthorizationSource {
  /** The pinned registry and the computers in it, or why that is not known right now. */
  readonly directory: Effect.Effect<DeviceDirectoryView, ConnectionAttemptError>;
  /** A pass for `audienceEnvironmentId`, bound to the DPoP key with that thumbprint. */
  readonly signAssertion: (input: {
    readonly audienceEnvironmentId: string;
    readonly dpopThumbprint: string;
  }) => Effect.Effect<string, ConnectionAttemptError>;
  /**
   * A computer refused a pass as `device_unknown` or `device_revoked`: this device may have been
   * removed. Called once per sign-in, without waiting, so the platform can ask the registry now
   * instead of at its next refresh.
   */
  readonly passRefused?: () => void;
}

/** Environments currently waiting for another computer to learn about this device. */
export interface PeerWaitStore {
  readonly begin: (environmentId: string) => void;
  readonly end: (environmentId: string) => void;
  readonly snapshot: () => ReadonlySet<string>;
  readonly subscribe: (listener: () => void) => () => void;
}

export const makePeerWaitStore = (): PeerWaitStore => {
  let current: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlySet<string>) => {
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    begin: (id) => {
      if (!current.has(id)) publish(new Set([...current, id]));
    },
    end: (id) => {
      if (current.has(id)) publish(new Set([...current].filter((other) => other !== id)));
    },
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export interface DeviceAuthorizationDeps {
  /** The DPoP key every session of this client is bound to. */
  readonly signer: ManagedRelayDpopSigner["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly source: DeviceAuthorizationSource;
  readonly index: DeviceEnvironmentIndexShape;
  readonly clientMetadata?: () => AuthClientPresentationMetadata | undefined;
  readonly wait?: PeerWaitStore;
  readonly retryDelaysMs?: ReadonlyArray<number>;
}

interface Session {
  readonly accessToken: string;
  readonly expiresAtEpochMs: number;
  readonly thumbprint: string;
}

/** `device_unknown`: the other computer's list does not hold this device yet. */
class PeerHasNotSynced {
  readonly _tag = "PeerHasNotSynced";
}

const isPeerHasNotSynced = (value: unknown): value is PeerHasNotSynced =>
  value instanceof PeerHasNotSynced;

const transient = (detail: string) => deviceConnectionTransient(detail);

const rejectedPass = (reason: string | undefined): ConnectionAttemptError | PeerHasNotSynced => {
  switch (reason) {
    case "device_unknown":
      return new PeerHasNotSynced();
    case "device_revoked":
      return deviceConnectionBlocked("This device was removed from your server.", "authentication");
    case "device_hidden":
      // This computer chose not to be seen by this device. It is not a removal, so nothing asks the registry.
      return deviceConnectionBlocked(
        "That computer is not available to this device.",
        "authentication",
      );
    case "time_window":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: "This device's clock differs from that computer's by more than two minutes.",
        hop: "device",
        via: "direct",
        failureCause: "clock_skew",
      });
    case "expired":
    case "replay":
      return transient("That computer asked for a fresh sign-in.");
    case "audience_mismatch":
    case "registry_mismatch":
      return deviceConnectionBlocked(
        "That computer is not the one this connection was saved for.",
        "authentication",
      );
    default:
      return deviceConnectionBlocked("That computer did not accept this device.", "authentication");
  }
};

const decodeAccessToken = Schema.decodeUnknownEffect(AuthAccessTokenResult);

export const makeDeviceKeyAuthorization = (
  deps: DeviceAuthorizationDeps,
): DeviceKeyAuthorizationShape => {
  const { signer, httpClient, source, index } = deps;
  const delays = deps.retryDelaysMs ?? DEVICE_UNKNOWN_RETRY_DELAYS_MS;
  const sessions = new Map<string, Session>();
  const routes = new Map<string, DeviceRoute>();
  const locks = new Map<string, Semaphore.Semaphore>();

  const lockFor = Effect.fn("deviceKeys.lockFor")(function* (environmentId: string) {
    const existing = locks.get(environmentId);
    if (existing !== undefined) return existing;
    const created = yield* Semaphore.make(1);
    locks.set(environmentId, created);
    return created;
  });

  const thumbprint = signer.thumbprint.pipe(
    Effect.mapError(() => deviceConnectionBlocked("Could not load this device's session key.")),
  );

  const mapFetch = (error: Parameters<typeof mapRemoteEnvironmentError>[0]) =>
    mapRemoteEnvironmentError(error, "direct");

  /** Everything checked before any pass leaves this device. */
  const resolveRoute = Effect.fn("deviceKeys.resolveRoute")(function* (input: {
    readonly expectedEnvironmentId: string;
    readonly httpBaseUrl: string;
  }) {
    const deviceId = index.get(input.expectedEnvironmentId);
    if (deviceId === undefined) {
      return yield* deviceConnectionBlocked("This environment is not managed by your server.");
    }
    const view = yield* source.directory;
    const computer = view.computers.find((entry) => entry.deviceId === deviceId && !entry.self);
    if (computer === undefined) {
      return yield* deviceConnectionBlocked(
        "That computer is no longer part of your server.",
        "authentication",
      );
    }
    const verdict = judgeRoute({
      view,
      computer,
      routeUrl: input.httpBaseUrl,
      expectedEnvironmentId: input.expectedEnvironmentId,
    });
    if (verdict._tag !== "ok") return yield* verdictError(verdict);
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: input.httpBaseUrl,
    }).pipe(Effect.mapError(mapFetch), Effect.provideService(HttpClient.HttpClient, httpClient));
    if (descriptor.environmentId !== input.expectedEnvironmentId) {
      return yield* environmentMismatchError({
        expected: input.expectedEnvironmentId as typeof descriptor.environmentId,
        actual: descriptor.environmentId,
      });
    }
    return { computer, descriptor };
  });

  const exchangeOnce = Effect.fn("deviceKeys.exchangePass")(function* (input: {
    readonly expectedEnvironmentId: string;
    readonly httpBaseUrl: string;
    readonly thumbprint: string;
    readonly onRemovalSuspected: () => void;
  }) {
    const assertion = yield* source.signAssertion({
      audienceEnvironmentId: input.expectedEnvironmentId,
      dpopThumbprint: input.thumbprint,
    });
    const url = environmentEndpointUrl(input.httpBaseUrl, T3X_DEVICE_TOKEN_PATH);
    const proof = yield* signer
      .createProof({ method: "POST", url })
      .pipe(
        Effect.mapError(() =>
          deviceConnectionBlocked("Could not sign the request to that computer."),
        ),
      );
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ dpop: proof, accept: "application/json" }),
      HttpClientRequest.bodyUrlParams({ grant_type: T3X_DEVICE_GRANT_TYPE, assertion }),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeoutOption(Duration.millis(PASS_REQUEST_TIMEOUT_MS)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new RemoteEnvironmentAuthTimeoutError({
                requestUrl: url,
                timeoutMs: PASS_REQUEST_TIMEOUT_MS,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isRemoteEnvironmentAuthTimeoutError(cause)
          ? mapFetch(cause)
          : mapFetch(
              new RemoteEnvironmentAuthFetchError({
                message: "Could not reach that computer.",
                cause,
              }),
            ),
      ),
    );
    if (response.status === 401) {
      const reason = response.headers["t3x-reason"];
      if (reason === "device_unknown" || reason === "device_revoked") input.onRemovalSuspected();
      return yield* Effect.fail(rejectedPass(reason));
    }
    if (response.status === 503) {
      return yield* transient("That computer cannot check devices until it reaches your server.");
    }
    if (response.status !== 200) {
      return yield* transient("That computer did not answer the sign-in request.");
    }
    const body = yield* response.json.pipe(
      Effect.flatMap(decodeAccessToken),
      Effect.mapError(() => transient("That computer sent a sign-in reply this app cannot read.")),
    );
    if (body.token_type !== "DPoP") {
      return yield* deviceConnectionBlocked("That computer did not issue a device-bound session.");
    }
    const issuedAt = yield* Clock.currentTimeMillis;
    return {
      accessToken: body.access_token,
      expiresAtEpochMs: issuedAt + body.expires_in * 1_000,
      thumbprint: input.thumbprint,
    } satisfies Session;
  });

  /** `device_unknown` is retried with backoff and shown as waiting; nothing else is retried. */
  const exchange = Effect.fn("deviceKeys.exchange")(
    function* (input: Omit<Parameters<typeof exchangeOnce>[0], "onRemovalSuspected">) {
      let attempt = 0;
      let asked = false;
      const onRemovalSuspected = () => {
        if (asked) return;
        asked = true;
        source.passRefused?.();
      };
      for (;;) {
        const result = yield* exchangeOnce({ ...input, onRemovalSuspected }).pipe(Effect.result);
        if (result._tag === "Success") return result.success;
        if (!isPeerHasNotSynced(result.failure)) return yield* result.failure;
        const delay = delays[attempt++];
        if (delay === undefined) {
          return yield* deviceConnectionBlocked(
            "That computer has not accepted this device yet. Try again in a minute.",
            "authentication",
          );
        }
        deps.wait?.begin(input.expectedEnvironmentId);
        yield* Effect.sleep(delay);
      }
    },
    (self, input) =>
      Effect.ensuring(
        self,
        Effect.sync(() => deps.wait?.end(input.expectedEnvironmentId)),
      ),
  );

  const sessionFor = Effect.fn("deviceKeys.session")(function* (
    route: Pick<DeviceRoute, "expectedEnvironmentId" | "httpBaseUrl">,
    rejectedAccessToken?: string,
  ) {
    const lock = yield* lockFor(route.expectedEnvironmentId);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const key = yield* thumbprint;
        const cached = sessions.get(route.expectedEnvironmentId);
        if (
          cached !== undefined &&
          cached.thumbprint === key &&
          cached.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS &&
          cached.accessToken !== rejectedAccessToken
        ) {
          return cached;
        }
        const fresh = yield* exchange({ ...route, thumbprint: key });
        sessions.set(route.expectedEnvironmentId, fresh);
        return fresh;
      }),
    );
  });

  const prepare: DeviceKeyAuthorizationShape["prepare"] = Effect.fn("deviceKeys.prepare")(
    function* (input) {
      const { descriptor } = yield* resolveRoute(input);
      const metadata = input.clientMetadata ?? deps.clientMetadata?.();
      routes.set(input.expectedEnvironmentId, input);
      const open = (session: Session) =>
        resolveRemoteDpopWebSocketConnectionUrl({
          wsBaseUrl: input.wsBaseUrl,
          httpBaseUrl: input.httpBaseUrl,
          accessToken: session.accessToken,
          createProof: (proof) =>
            signer
              .createProof(proof)
              .pipe(
                Effect.mapError(() =>
                  deviceConnectionBlocked("Could not sign the connection request."),
                ),
              ),
          ...(metadata === undefined ? {} : { clientMetadata: metadata }),
          connectionMethod: "direct",
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError((error) =>
            error._tag === "ConnectionBlockedError" ? error : mapFetch(error),
          ),
        );
      let session = yield* sessionFor(input);
      let socketUrl = yield* open(session).pipe(Effect.result);
      if (socketUrl._tag === "Failure") {
        // A session the computer no longer honours is dropped; one fresh pass is tried.
        const failure = socketUrl.failure;
        if (failure._tag === "ConnectionTransientError") return yield* failure;
        sessions.delete(input.expectedEnvironmentId);
        session = yield* sessionFor(input, session.accessToken);
        socketUrl = yield* open(session).pipe(Effect.result);
        if (socketUrl._tag === "Failure") return yield* socketUrl.failure;
      }
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl: socketUrl.success,
        descriptor,
        httpAuthorization: {
          _tag: "Dpop" as const,
          accessToken: session.accessToken,
          expiresAtEpochMs: session.expiresAtEpochMs,
        },
      } satisfies AuthorizedRemoteEnvironment;
    },
  );

  const authorizeHttp: DeviceKeyAuthorizationShape["authorizeHttp"] = Effect.fn(
    "deviceKeys.authorizeHttp",
  )(function* (input) {
    if (!sessions.has(input.expectedEnvironmentId)) yield* resolveRoute(input);
    const session = yield* sessionFor(input, input.rejectedAccessToken);
    return {
      environmentId: input.expectedEnvironmentId as AuthorizedRemoteEnvironment["environmentId"],
      label: "",
      httpBaseUrl: input.httpBaseUrl,
      httpAuthorization: {
        _tag: "Dpop" as const,
        accessToken: session.accessToken,
        expiresAtEpochMs: session.expiresAtEpochMs,
      },
    };
  });

  // Untraced: a span here would stay open for the socket's lifetime. Each renewal has its own.
  const renew: DeviceKeyAuthorizationShape["renew"] = Effect.fnUntraced(function* (input) {
    let expiresAtEpochMs = input.expiresAtEpochMs;
    let now = yield* Clock.currentTimeMillis;
    while (now < expiresAtEpochMs) {
      yield* Effect.sleep(
        Math.max(5_000, expiresAtEpochMs - DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS - now),
      );
      const route = routes.get(input.expectedEnvironmentId);
      if (route === undefined) {
        return yield* deviceConnectionBlocked("That computer is no longer part of your server.");
      }
      const renewed = yield* resolveRoute(route).pipe(
        Effect.andThen(sessionFor(route)),
        Effect.map((session) => session.expiresAtEpochMs),
        // A blip retries until expiry; a refusal ends the loop.
        Effect.catchTags({ ConnectionTransientError: () => Effect.succeed(expiresAtEpochMs) }),
      );
      expiresAtEpochMs = Math.max(expiresAtEpochMs, renewed);
      now = yield* Clock.currentTimeMillis;
    }
  });

  const forget: DeviceKeyAuthorizationShape["forget"] = (environmentId) =>
    Effect.sync(() => {
      sessions.delete(environmentId);
      routes.delete(environmentId);
      locks.delete(environmentId);
      deps.wait?.end(environmentId);
    });

  return { prepare, authorizeHttp, renew, forget };
};
