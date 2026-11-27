// fork: the computer's side of the registry API (design 3.3 / 3.4 / 3.12). Every request is signed
// with the device key; the only origin ever contacted is the one pinned at join.
import {
  DeviceVisibility,
  RegistryDevicesResponse,
  RegistryInfo,
  RegistryJoinResponse,
  type DeviceKind,
} from "@t3tools/contracts";
import { signRequestProof, canonicalOrigin } from "@t3tools/shared/forkDeviceKeys/proof";
import type { DeviceJwk } from "@t3tools/shared/forkDeviceKeys/jws";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export class RegistryClientError extends Schema.TaggedError<RegistryClientError>()(
  "RegistryClientError",
  {
    /** `unreachable`: no answer. `rejected`: the registry said no. `protocol`: it answered nonsense or the wrong registry. */
    kind: Schema.Literals(["unreachable", "rejected", "protocol"]),
    status: Schema.optionalKey(Schema.Number),
    /** The registry's `error` code. */
    code: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.kind === "rejected"
      ? `The registry rejected the request (${this.code ?? this.status}).`
      : `The registry could not be used (${this.kind}).`;
  }
}

/** Who is asking, and which registry they pinned. */
export interface RegistryTarget {
  readonly origin: string;
  readonly registryId: string;
  readonly deviceId: string;
  readonly privateKey: Uint8Array;
}

const REQUEST_TIMEOUT = "15 seconds";

/**
 * The registry is pinned by origin: a redirect would hand the signed request to another host.
 * fetch follows redirects by default, so every call asks for the 3xx itself and refuses it.
 */
const withoutRedirects = Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" });

/** No registry answer is a redirect (or a status below 200), a 304 included: treating one as data would trust another host. */
const isRedirect = (status: number) => status < 200 || (status >= 300 && status < 400);
const redirected = (status: number) =>
  new RegistryClientError({ kind: "protocol", status, code: "redirect" });
const decodeJsonUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

export class RegistryClient extends Context.Service<
  RegistryClient,
  {
    readonly info: (origin: string) => Effect.Effect<RegistryInfo, RegistryClientError>;
    readonly join: (input: {
      readonly origin: string;
      readonly invite: string;
      readonly privateKey: Uint8Array;
      readonly jwk: DeviceJwk;
      readonly name: string;
      readonly kind: DeviceKind;
      readonly environmentId: string;
    }) => Effect.Effect<RegistryJoinResponse, RegistryClientError>;
    /** Always the registry's current list: `online` and the sync times change without `rev` moving. */
    readonly listDevices: (
      target: RegistryTarget,
    ) => Effect.Effect<RegistryDevicesResponse, RegistryClientError>;
    readonly createInvite: (
      target: RegistryTarget,
      kind: DeviceKind,
    ) => Effect.Effect<
      { readonly id: string; readonly invite: string; readonly expiresAt: number },
      RegistryClientError
    >;
    readonly cancelInvite: (
      target: RegistryTarget,
      id: string,
    ) => Effect.Effect<void, RegistryClientError>;
    readonly removeDevice: (
      target: RegistryTarget,
      deviceId: string,
    ) => Effect.Effect<{ readonly removedAt: number; readonly rev: number }, RegistryClientError>;
    readonly renameDevice: (
      target: RegistryTarget,
      deviceId: string,
      name: string,
    ) => Effect.Effect<{ readonly id: string; readonly name: string }, RegistryClientError>;
    readonly reportEnvironment: (
      target: RegistryTarget,
      environmentId: string,
    ) => Effect.Effect<void, RegistryClientError>;
    /** A registry without the setting answers 404 `not_found`, because it has no such route. */
    readonly setVisibility: (
      target: RegistryTarget,
      visibility: DeviceVisibility,
    ) => Effect.Effect<
      { readonly rev: number; readonly visibility: DeviceVisibility },
      RegistryClientError
    >;
  }
>()("t3/fork/deviceKeys/RegistryClient") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;

  const send = Effect.fn("RegistryClient.send")(function* (input: {
    readonly origin: string;
    readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    readonly path: string;
    readonly body?: unknown;
    readonly proof: Omit<Parameters<typeof signRequestProof>[0], "method" | "htu" | "body" | "iat">;
  }) {
    const origin = yield* Effect.try({
      try: () => canonicalOrigin(input.origin),
      catch: (cause) => new RegistryClientError({ kind: "protocol", cause }),
    });
    const bodyText = input.body === undefined ? undefined : encodeJson(input.body);
    const bodyBytes = bodyText === undefined ? undefined : new TextEncoder().encode(bodyText);
    const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const proof = signRequestProof({
      ...input.proof,
      method: input.method,
      htu: `${origin}${input.path}`,
      iat,
      ...(bodyBytes === undefined ? {} : { body: bodyBytes }),
    });
    const base = HttpClientRequest.make(input.method)(`${origin}${input.path}`).pipe(
      HttpClientRequest.setHeaders({ "t3x-proof": proof }),
    );
    // A string/bytes body goes out with a Content-Length; the registry refuses chunked uploads.
    const request =
      bodyBytes === undefined
        ? base
        : HttpClientRequest.bodyUint8Array(base, bodyBytes, "application/json");
    const response = yield* http.execute(request).pipe(
      withoutRedirects,
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => new RegistryClientError({ kind: "unreachable", cause })),
    );
    const text = yield* response.text.pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => new RegistryClientError({ kind: "unreachable", cause })),
    );
    if (isRedirect(response.status)) return yield* redirected(response.status);
    const json = decodeJsonUnknown(text);
    if (response.status >= 200 && response.status < 300) {
      return { status: response.status, text, json: json._tag === "Some" ? json.value : undefined };
    }
    const code = json._tag === "Some" ? decodeErrorBody(json.value) : undefined;
    return yield* new RegistryClientError({
      kind: "rejected",
      status: response.status,
      ...(code?._tag === "Some" ? { code: code.value.error } : {}),
    });
  });

  const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((cause) => new RegistryClientError({ kind: "protocol", cause })),
    );

  const proofOf = (target: RegistryTarget) => ({
    privateKey: target.privateKey,
    kid: target.deviceId,
  });

  const requireRegistry = (target: RegistryTarget, actual: string) =>
    actual === target.registryId
      ? Effect.void
      : Effect.fail(new RegistryClientError({ kind: "protocol", code: "registry_mismatch" }));

  return RegistryClient.of({
    info: Effect.fn("RegistryClient.info")(function* (origin) {
      const canonical = yield* Effect.try({
        try: () => canonicalOrigin(origin),
        catch: (cause) => new RegistryClientError({ kind: "protocol", cause }),
      });
      const response = yield* http.get(`${canonical}/v1/info`).pipe(
        withoutRedirects,
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) => new RegistryClientError({ kind: "unreachable", cause })),
      );
      const text = yield* response.text.pipe(
        Effect.mapError((cause) => new RegistryClientError({ kind: "unreachable", cause })),
      );
      if (isRedirect(response.status)) return yield* redirected(response.status);
      if (response.status !== 200) {
        return yield* new RegistryClientError({ kind: "rejected", status: response.status });
      }
      const json = decodeJsonUnknown(text);
      return yield* decode(RegistryInfo, json._tag === "Some" ? json.value : undefined);
    }),
    join: Effect.fn("RegistryClient.join")(function* (input) {
      const result = yield* send({
        origin: input.origin,
        method: "POST",
        path: "/v1/join",
        body: {
          invite: input.invite,
          device: {
            name: input.name,
            kind: input.kind,
            jwk: input.jwk,
            environmentId: input.environmentId,
          },
        },
        proof: { privateKey: input.privateKey, jwk: input.jwk },
      });
      return yield* decode(RegistryJoinResponse, result.json);
    }),
    listDevices: Effect.fn("RegistryClient.listDevices")(function* (target) {
      const result = yield* send({
        origin: target.origin,
        method: "GET",
        path: "/v1/devices",
        proof: proofOf(target),
      });
      const body = yield* decode(RegistryDevicesResponse, result.json);
      yield* requireRegistry(target, body.registryId);
      return body;
    }),
    createInvite: Effect.fn("RegistryClient.createInvite")(function* (target, kind) {
      const result = yield* send({
        origin: target.origin,
        method: "POST",
        path: "/v1/invites",
        body: { kind },
        proof: proofOf(target),
      });
      return yield* decode(
        Schema.Struct({ id: Schema.String, invite: Schema.String, expiresAt: Schema.Number }),
        result.json,
      );
    }),
    cancelInvite: Effect.fn("RegistryClient.cancelInvite")(function* (target, id) {
      yield* send({
        origin: target.origin,
        method: "DELETE",
        path: `/v1/invites/${id}`,
        proof: proofOf(target),
      });
    }),
    removeDevice: Effect.fn("RegistryClient.removeDevice")(function* (target, deviceId) {
      const result = yield* send({
        origin: target.origin,
        method: "DELETE",
        path: `/v1/devices/${deviceId}`,
        proof: proofOf(target),
      });
      return yield* decode(
        Schema.Struct({ removedAt: Schema.Number, rev: Schema.Number }),
        result.json,
      );
    }),
    renameDevice: Effect.fn("RegistryClient.renameDevice")(function* (target, deviceId, name) {
      const result = yield* send({
        origin: target.origin,
        method: "PATCH",
        path: `/v1/devices/${deviceId}`,
        body: { name },
        proof: proofOf(target),
      });
      return yield* decode(Schema.Struct({ id: Schema.String, name: Schema.String }), result.json);
    }),
    reportEnvironment: Effect.fn("RegistryClient.reportEnvironment")(
      function* (target, environmentId) {
        yield* send({
          origin: target.origin,
          method: "PATCH",
          path: "/v1/devices/self",
          body: { environmentId },
          proof: proofOf(target),
        });
      },
    ),
    setVisibility: Effect.fn("RegistryClient.setVisibility")(function* (target, visibility) {
      const result = yield* send({
        origin: target.origin,
        method: "PUT",
        path: "/v1/devices/self/visibility",
        body: { mode: visibility.mode, deviceIds: visibility.deviceIds },
        proof: proofOf(target),
      });
      return yield* decode(
        Schema.Struct({ rev: Schema.Number, visibility: DeviceVisibility }),
        result.json,
      );
    }),
  });
});

export const layer = Layer.effect(RegistryClient, make);
