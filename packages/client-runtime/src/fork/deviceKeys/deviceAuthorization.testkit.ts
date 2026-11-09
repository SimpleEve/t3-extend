// fork: shared fixtures for the device-authorization tests: a computer on the user's own server, a
// fake network that records every request, and a source that signs passes without real keys.
import { EnvironmentId, T3X_DEVICE_TOKEN_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../../connection/catalog.ts";
import { BearerConnectionTarget } from "../../connection/model.ts";
import * as ManagedRelay from "../../relay/managedRelay.ts";
import * as RpcHttp from "../../rpc/http.ts";
import {
  deviceConnectionId,
  deviceListNotReady,
  makeDeviceEnvironmentIndex,
} from "./DeviceKeyAuthorization.ts";
import type { DeviceComputer, DeviceDirectoryView } from "./discovery.ts";
import {
  makeDeviceKeyAuthorization,
  makePeerWaitStore,
  type DeviceAuthorizationSource,
} from "./liveAuthorization.ts";

const REGISTRY_ORIGIN = "https://t3.example.test";
export const COMPUTER_URL = "https://mac.t3.example.test";
export const ENVIRONMENT_ID = EnvironmentId.make("environment-mac");
export const DEVICE_ID = "device-mac";
export const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-other");
export const THUMBPRINT = "dpop-key-thumbprint";

/** A saved environment as the connection directory holds it after the device sync registered it. */
export const deviceEntry = (
  deviceId: string,
  environmentId: string,
  options?: { readonly learned?: boolean },
): ConnectionCatalogEntry => {
  const connectionId = deviceConnectionId(deviceId);
  return {
    target: new BearerConnectionTarget({
      environmentId: EnvironmentId.make(environmentId),
      label: "Mac",
      connectionId,
    }),
    enabled: true,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId: EnvironmentId.make(environmentId),
        label: "Mac",
        httpBaseUrl: COMPUTER_URL,
        wsBaseUrl: COMPUTER_URL.replace(/^http/, "ws"),
        authorization: "t3x-device",
        ...(options?.learned === true ? { learned: true } : {}),
      }),
    ),
  };
};

export const computer = (overrides: Partial<DeviceComputer> = {}): DeviceComputer => ({
  deviceId: DEVICE_ID,
  name: "Mac",
  url: COMPUTER_URL,
  environmentId: ENVIRONMENT_ID,
  self: false,
  ...overrides,
});

export const view = (
  computers: ReadonlyArray<DeviceComputer> = [computer()],
  recordsEnvironmentIds = true,
): DeviceDirectoryView => ({
  pin: { origin: REGISTRY_ORIGIN, registryId: "abcdefgh" },
  computers,
  recordsEnvironmentIds,
});

export const descriptorJson = (environmentId: string = ENVIRONMENT_ID) => ({
  environmentId,
  label: "Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
});

export const accessTokenJson = (token: string, expiresIn = 3_600) => ({
  access_token: token,
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "DPoP",
  expires_in: expiresIn,
  scope: "orchestration:read",
});

export const rejectedPass = (reason: string, status = 401) =>
  new Response(JSON.stringify({ error: "invalid" }), {
    status,
    headers: { "content-type": "application/json", "t3x-reason": reason },
  });

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
}

export type PassReply = Response | (() => Response);

export const makeRig = Effect.fn("DeviceAuthorizationRig.make")(function* (input?: {
  readonly view?: DeviceDirectoryView;
  /** The server's list has not arrived yet. */
  readonly listNotReady?: boolean;
  readonly passReplies?: ReadonlyArray<PassReply>;
  readonly descriptorEnvironmentId?: string;
  readonly retryDelaysMs?: ReadonlyArray<number>;
}) {
  const requests: Array<RecordedRequest> = [];
  const passAttempts = yield* Queue.unbounded<number>();
  const passReplies = [...(input?.passReplies ?? [])];
  let passCount = 0;
  let tokenCount = 0;
  const fetchFn: typeof fetch = async (request, init) => {
    const url = String(request);
    const method = init?.method ?? "GET";
    requests.push({ method, url, headers: new Headers(init?.headers) });
    const path = new URL(url).pathname;
    if (path === "/.well-known/t3/environment") {
      return Response.json(descriptorJson(input?.descriptorEnvironmentId));
    }
    if (path === T3X_DEVICE_TOKEN_PATH) {
      passCount += 1;
      Queue.offerUnsafe(passAttempts, passCount);
      const reply = passReplies.shift();
      if (reply === undefined) return Response.json(accessTokenJson(`token-${++tokenCount}`));
      return typeof reply === "function" ? reply() : reply;
    }
    if (path.startsWith("/api/auth/websocket-ticket")) {
      return Response.json({ ticket: "ws-ticket", expiresAt: "2026-06-06T01:00:00.000Z" });
    }
    return new Response("unexpected", { status: 500 });
  };
  const httpClient = yield* HttpClient.HttpClient.pipe(
    Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
  );
  const current = yield* Ref.make(input?.view ?? view());
  const listReady = yield* Ref.make(input?.listNotReady !== true);
  const signed = yield* Ref.make<ReadonlyArray<{ audience: string; jkt: string }>>([]);
  let refusals = 0;
  const source: DeviceAuthorizationSource = {
    passRefused: () => {
      refusals += 1;
    },
    directory: Ref.get(listReady).pipe(
      Effect.flatMap((ready) => (ready ? Ref.get(current) : Effect.fail(deviceListNotReady()))),
    ),
    signAssertion: ({ audienceEnvironmentId, dpopThumbprint }) =>
      Ref.updateAndGet(signed, (all) => [
        ...all,
        { audience: audienceEnvironmentId, jkt: dpopThumbprint },
      ]).pipe(Effect.map((all) => `assertion-${all.length}`)),
  };
  const proofs: Array<ManagedRelay.ManagedRelayDpopProofInput> = [];
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed(THUMBPRINT),
    createProof: (proof) =>
      Effect.sync(() => {
        proofs.push(proof);
        return `proof:${proof.method}:${proof.url}`;
      }),
  });
  // The directory the registry restored: the computer's environment is saved, no sync has run.
  const directory = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[ENVIRONMENT_ID, deviceEntry(DEVICE_ID, ENVIRONMENT_ID)]]),
  );
  const index = makeDeviceEnvironmentIndex();
  index.bind(directory);
  const wait = makePeerWaitStore();
  const waits: Array<ReadonlySet<string>> = [];
  wait.subscribe(() => waits.push(wait.snapshot()));
  const authorization = makeDeviceKeyAuthorization({
    signer,
    httpClient,
    source,
    index,
    wait,
    clientMetadata: () => ({ label: "Test", deviceType: "desktop", os: "macOS" }),
    ...(input?.retryDelaysMs === undefined ? {} : { retryDelaysMs: input.retryDelaysMs }),
  });
  return {
    authorization,
    requests,
    proofs,
    passAttempts,
    signed,
    current,
    listReady,
    directory,
    index,
    wait,
    waits,
    refusals: () => refusals,
    passRequests: () =>
      requests.filter((request) => new URL(request.url).pathname === T3X_DEVICE_TOKEN_PATH),
  };
});

export const route = (httpBaseUrl: string = COMPUTER_URL) => ({
  expectedEnvironmentId: ENVIRONMENT_ID as string,
  httpBaseUrl,
  wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
});
