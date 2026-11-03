// fork: shared fixtures for the device-authorization tests: a computer on the user's own server, a
// fake network that records every request, and a source that signs passes without real keys.
import { EnvironmentId, T3X_DEVICE_TOKEN_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";

import * as ManagedRelay from "../../relay/managedRelay.ts";
import * as RpcHttp from "../../rpc/http.ts";
import { makeDeviceEnvironmentIndex } from "./DeviceKeyAuthorization.ts";
import type { DeviceComputer, DeviceDirectoryView } from "./discovery.ts";
import {
  makeDeviceKeyAuthorization,
  makePeerWaitStore,
  type DeviceAuthorizationSource,
} from "./liveAuthorization.ts";

const REGISTRY_ORIGIN = "https://t3.example.test";
export const COMPUTER_URL = "https://mac.t3.example.test";
export const ENVIRONMENT_ID = EnvironmentId.make("environment-mac");
const DEVICE_ID = "device-mac";
export const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-other");
export const THUMBPRINT = "dpop-key-thumbprint";

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
  const signed = yield* Ref.make<ReadonlyArray<{ audience: string; jkt: string }>>([]);
  const source: DeviceAuthorizationSource = {
    directory: Ref.get(current),
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
  const index = makeDeviceEnvironmentIndex();
  index.replace(new Map([[ENVIRONMENT_ID, DEVICE_ID]]));
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
    index,
    wait,
    waits,
    passRequests: () =>
      requests.filter((request) => new URL(request.url).pathname === T3X_DEVICE_TOKEN_PATH),
  };
});

export const route = (httpBaseUrl: string = COMPUTER_URL) => ({
  expectedEnvironmentId: ENVIRONMENT_ID as string,
  httpBaseUrl,
  wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
});
