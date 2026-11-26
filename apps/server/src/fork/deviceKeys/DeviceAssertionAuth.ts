// fork: POST /oauth/t3x-device (design Q2 / 3.5). A device presents a pass signed for exactly this
// computer, together with a DPoP proof, and gets the same DPoP-bound session `/oauth/token` hands out.
// The pipeline reuses `/oauth/token`'s own functions at every step; see 3.5 for the line-by-line table.
import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthGrantScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  T3X_DEVICE_GRANT_TYPE,
  T3X_DEVICE_SUBJECT_PREFIX,
  T3X_DEVICE_TOKEN_PATH,
  type AuthEnvironmentScope,
  type AuthAccessTokenResult,
} from "@t3tools/contracts";
import {
  ASSERTION_CLOCK_SKEW_SECONDS,
  ASSERTION_MAX_LIFETIME_SECONDS,
  parseAssertion,
  verifyAssertionSignature,
} from "@t3tools/shared/forkDeviceKeys/assertion";
import { ProofError } from "@t3tools/shared/forkDeviceKeys/jws";
import { encodeOAuthScope, parseOAuthScope } from "@t3tools/shared/oauthScope";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import {
  annotateEnvironmentRequest,
  appendCredentialResponseHeaders,
  appendDpopChallengeHeader,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
} from "../../auth/http.ts";
import { verifyRequestDpopProof } from "../../auth/dpop.ts";
import { deriveAuthClientMetadata } from "../../auth/utils.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { isVisibleTo } from "@t3tools/shared/forkDeviceKeys/visibility";
import * as DeviceDirectory from "./DeviceDirectory.ts";

export const T3X_ASSERTION_MARKER_PREFIX = "t3x-assertion-";
const BODY_LIMIT_BYTES = 8192;
const SESSION_TTL = Duration.hours(1);

/** Why a pass was not accepted. Sent in the `t3x-reason` header (not the JSON body) and logged. */
export type AssertionRejection =
  | "bad_assertion"
  | "device_unknown"
  | "bad_signature"
  | "audience_mismatch"
  | "registry_mismatch"
  | "expired"
  | "time_window"
  | "replay"
  | "key_mismatch"
  | "device_revoked"
  | "device_hidden"
  | "dpop_invalid";

/** Phones never manage devices or relay tokens, whatever scope they ask for. */
const PHONE_WITHHELD_SCOPES: ReadonlySet<AuthEnvironmentScope> = new Set([
  AuthAccessWriteScope,
  AuthRelayWriteScope,
]);

const scopesForDevice = (kind: "computer" | "phone"): ReadonlyArray<AuthEnvironmentScope> =>
  kind === "computer"
    ? AuthStandardClientScopes
    : AuthStandardClientScopes.filter((scope) => !PHONE_WITHHELD_SCOPES.has(scope));

// Browsers hide non-safelisted response headers from cross-origin pages unless they are listed here.
// The CORS middleware only sets its own keys, so this survives it; do not give `layerBrowserApiCors`
// an `exposedHeaders` of its own without adding this name, or it will replace this value.
const exposeReason = { "access-control-expose-headers": "t3x-reason" } as const;

const withReason = (reason: AssertionRejection) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, { ...exposeReason, "t3x-reason": reason }),
    ),
  );

const rejected = (reason: AssertionRejection) =>
  withReason(reason).pipe(
    Effect.andThen(
      Effect.logWarning("Device pass rejected.", { reason }).pipe(
        Effect.andThen(failEnvironmentAuthInvalid("invalid_credential")),
      ),
    ),
  );

const unavailable = (reason: "list_unavailable" | "list_expired") =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { error: "service_unavailable" },
      {
        status: 503,
        headers: {
          ...exposeReason,
          "t3x-reason": reason,
          "cache-control": "no-store",
          pragma: "no-cache",
        },
      },
    ),
  );

const malformed = Effect.succeed(
  HttpServerResponse.jsonUnsafe(
    { code: "invalid_request", error: "invalid_request" },
    { status: 400, headers: { "cache-control": "no-store", pragma: "no-cache" } },
  ),
);

/** Form body with an explicit, bounded length. Chunked or oversized bodies are refused. */
const readForm = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const declared = request.headers["content-length"];
  if (
    declared === undefined ||
    !/^\d{1,9}$/.test(declared) ||
    Number(declared) > BODY_LIMIT_BYTES
  ) {
    return Option.none<URLSearchParams>();
  }
  const text = yield* request.text.pipe(Effect.option);
  return Option.filter(text, (value) => value.length <= BODY_LIMIT_BYTES).pipe(
    Option.map((value) => new URLSearchParams(value)),
  );
});

const make = Effect.gen(function* () {
  const directory = yield* DeviceDirectory.DeviceDirectory;
  const sessions = yield* SessionStore.SessionStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const digestService = yield* Digest.Digest;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;

  const markerName = (kid: string, jti: string) =>
    digestService.digest(Digest.sha256, new TextEncoder().encode(`${kid}:${jti}`)).pipe(
      Effect.map((digest) => `${T3X_ASSERTION_MARKER_PREFIX}${Base64Url.encode(digest)}`),
      Effect.orDie,
    );

  const handle = Effect.fn("environment.auth.t3xDevice")(function* () {
    yield* annotateEnvironmentRequest("t3xDevice");
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* appendCredentialResponseHeaders;

    const form = yield* readForm(request);
    if (
      Option.isNone(form) ||
      form.value.get("grant_type") !== T3X_DEVICE_GRANT_TYPE ||
      (form.value.get("assertion") ?? "").length === 0
    ) {
      return yield* malformed;
    }
    const assertion = form.value.get("assertion") ?? "";
    const rawScope = form.value.get("scope");
    const requestedScopes =
      rawScope === null
        ? undefined
        : (parseOAuthScope(rawScope)?.filter(Schema.is(AuthGrantScope)) ?? null);
    if (requestedScopes === null || requestedScopes?.length === 0) {
      return yield* failEnvironmentInvalidRequest("invalid_scope");
    }

    // Step 1: shape, then whether this computer can judge a pass at all.
    const parsed = yield* Effect.try({
      try: () => parseAssertion(assertion),
      catch: (error) => (error instanceof ProofError ? error : new ProofError("malformed")),
    }).pipe(Effect.catch(() => rejected("bad_assertion")));
    const local = yield* directory.state;
    if (Option.isNone(local.list) || Option.isNone(local.membership)) {
      return yield* unavailable("list_unavailable");
    }
    if (local.staleness === "expired") return yield* unavailable("list_expired");

    // Step 2: who signed it, with which key.
    const claims = parsed.claims;
    const signer = DeviceDirectory.findSigner(local.list.value, parsed.kid);
    if (signer === undefined) {
      // A device joined a moment ago may be on the registry's list already; the retry finds it.
      yield* directory.refreshSoon;
      return yield* rejected("device_unknown");
    }
    if (claims.iss !== parsed.kid || claims.sub !== parsed.kid) {
      return yield* rejected("bad_assertion");
    }
    if (!verifyAssertionSignature(parsed, signer.jwk)) return yield* rejected("bad_signature");
    // This computer's own choice, read from its file: the registry's list is not what decides it.
    if (!isVisibleTo(yield* directory.visibility, parsed.kid))
      return yield* rejected("device_hidden");

    // Step 3-4: meant for this computer, in this registry, right now.
    if (claims.aud !== environmentId) return yield* rejected("audience_mismatch");
    if (claims.rid !== local.membership.value.registryId) {
      return yield* rejected("registry_mismatch");
    }
    if (local.nowSeconds >= claims.exp) return yield* rejected("expired");
    if (
      Math.abs(local.nowSeconds - claims.iat) > ASSERTION_CLOCK_SKEW_SECONDS ||
      claims.exp - claims.iat > ASSERTION_MAX_LIFETIME_SECONDS ||
      claims.exp <= claims.iat
    ) {
      return yield* rejected("time_window");
    }

    // Step 5: the DPoP proof for the key the pass names; `/oauth/token`'s own function.
    yield* verifyRequestDpopProof({ request, expectedThumbprint: claims.jkt }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(Digest.Digest, digestService),
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) => {
        const dpopReason = EnvironmentAuth.serverAuthDpopFailureReason(error);
        return appendDpopChallengeHeader.pipe(
          Effect.andThen(
            withReason(
              dpopReason === "replay" ||
                dpopReason === "key_mismatch" ||
                dpopReason === "time_window"
                ? dpopReason
                : "dpop_invalid",
            ),
          ),
          Effect.andThen(failEnvironmentAuthInvalid("invalid_credential", dpopReason)),
        );
      }),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("access_token_issuance_failed", error),
      ),
    );

    // Step 6: the same lock the reconcile holds. Re-check membership, spend the pass, issue.
    const marker = yield* markerName(parsed.kid, claims.jti);
    const issued = yield* directory.withGate(
      Effect.gen(function* () {
        const current = yield* directory.state;
        const device = Option.map(current.list, (list) =>
          DeviceDirectory.findSigner(list, parsed.kid),
        ).pipe(Option.getOrUndefined);
        if (device === undefined) return yield* rejected("device_revoked");
        // Re-read under the gate: a setting saved while this pass waited for the gate still applies.
        if (!isVisibleTo(yield* directory.visibility, parsed.kid)) {
          return yield* rejected("device_hidden");
        }
        const created = yield* secrets.create(marker, new Uint8Array()).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            ServerSecretStore.isSecretAlreadyExistsError(error)
              ? Effect.succeed(false)
              : failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        );
        if (!created) return yield* rejected("replay");
        const standard = scopesForDevice(device.kind);
        const granted =
          requestedScopes === undefined
            ? standard
            : standard.filter((scope) =>
                (requestedScopes as ReadonlyArray<string>).includes(scope),
              );
        if (granted.length === 0) return yield* failEnvironmentInvalidRequest("scope_not_granted");
        return yield* sessions
          .issue({
            method: "dpop-access-token",
            subject: `${T3X_DEVICE_SUBJECT_PREFIX}${device.kind}:${device.id}`,
            scopes: granted,
            proofKeyThumbprint: claims.jkt,
            ttl: SESSION_TTL,
            client: deriveAuthClientMetadata({
              request,
              presented: {
                // A computer hidden from this one has no name here, only a key.
                label: "name" in device ? device.name : "Computer",
                deviceType: device.kind === "phone" ? "mobile" : "desktop",
              },
            }),
          })
          .pipe(
            Effect.catch((error) => failEnvironmentInternal("access_token_issuance_failed", error)),
          );
      }),
    );

    const now = local.nowSeconds;
    return HttpServerResponse.jsonUnsafe({
      access_token: issued.token,
      issued_token_type: AuthAccessTokenType,
      token_type: "DPoP",
      expires_in: Math.max(0, Math.floor(issued.expiresAt.epochMilliseconds / 1000) - now),
      scope: encodeOAuthScope(issued.scopes),
    } satisfies AuthAccessTokenResult);
  });

  return HttpRouter.add("POST", T3X_DEVICE_TOKEN_PATH, handle());
});

export const layerRoute = Layer.unwrap(make);
