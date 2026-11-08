// fork: the phone's side of the registry API (design 3.3). Only three calls: who the registry is,
// join, and the signed device list. Every request goes to the one origin pinned at join, and a
// redirect is refused because it would hand a signed request to another host.
import { RegistryDevicesResponse, RegistryInfo, RegistryJoinResponse } from "@t3tools/contracts";
import { b64u, type DeviceJwk, type DeviceKeyPair } from "@t3tools/shared/forkDeviceKeys/jws";
import { canonicalOrigin, signRequestProof } from "@t3tools/shared/forkDeviceKeys/proof";
import * as Schema from "effect/Schema";

// @effect-diagnostics-next-line extendsNativeError:off - fork: thrown through plain promises in the phone's registry client, outside Effect.
export class RegistryError extends Error {
  /** `unreachable`: no answer. `rejected`: the registry said no. `protocol`: it answered nonsense or the wrong registry. */
  readonly kind: "unreachable" | "rejected" | "protocol";
  readonly status: number | undefined;
  /** The registry's own `error` code, such as `invite_used` or `device_unknown`. */
  readonly code: string | undefined;
  constructor(kind: RegistryError["kind"], status?: number, code?: string) {
    super(`registry ${kind}${code === undefined ? "" : `: ${code}`}`);
    this.name = "RegistryError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** What the registry calls need from a fetch; both the global one and `expo/fetch` satisfy it. */
export type RegistryFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
    readonly body?: Uint8Array;
  },
) => Promise<Pick<Response, "status" | "redirected" | "url" | "text">>;

export interface RegistryEnvironment {
  readonly fetch: RegistryFetch;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly nowSeconds: () => number;
}

export interface RegistryTarget {
  readonly origin: string;
  readonly registryId: string;
  readonly key: DeviceKeyPair;
}

const REQUEST_TIMEOUT_MS = 15_000;
const decodeInfo = Schema.decodeUnknownSync(RegistryInfo);
const decodeJoin = Schema.decodeUnknownSync(RegistryJoinResponse);
const decodeDevices = Schema.decodeUnknownSync(RegistryDevicesResponse);

/** A response that came from another origin than the one asked is never the registry's answer. */
const isOtherOrigin = (responseUrl: string, origin: string): boolean => {
  if (typeof responseUrl !== "string" || responseUrl === "") return false;
  try {
    return new URL(responseUrl).origin !== origin;
  } catch {
    return true;
  }
};

const protocol = (status?: number, code?: string) => new RegistryError("protocol", status, code);

async function send(
  env: RegistryEnvironment,
  input: {
    readonly origin: string;
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
    readonly proof?:
      | { readonly kid: string; readonly privateKey: Uint8Array }
      | { readonly jwk: DeviceJwk; readonly privateKey: Uint8Array };
  },
): Promise<{ readonly status: number; readonly json: unknown }> {
  let origin: string;
  try {
    origin = canonicalOrigin(input.origin);
  } catch {
    throw protocol();
  }
  const bodyBytes =
    input.body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(input.body));
  const headers: Record<string, string> = {};
  if (input.proof !== undefined) {
    headers["t3x-proof"] = signRequestProof({
      ...input.proof,
      method: input.method,
      htu: `${origin}${input.path}`,
      iat: env.nowSeconds(),
      jti: b64u.encode(env.randomBytes(16)),
      ...(bodyBytes === undefined ? {} : { body: bodyBytes }),
    });
  }
  if (bodyBytes !== undefined) headers["content-type"] = "application/json";
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  const requested = `${origin}${input.path}`;
  let response: Awaited<ReturnType<RegistryFetch>>;
  let text: string;
  try {
    response = await env.fetch(requested, {
      method: input.method,
      headers,
      redirect: "manual",
      signal: abort.signal,
      ...(bodyBytes === undefined ? {} : { body: bodyBytes }),
    });
    text = await response.text();
  } catch {
    throw new RegistryError("unreachable");
  } finally {
    clearTimeout(timer);
  }
  // A redirect (or an opaque redirect, status 0) is never data: it points at another host. Some
  // runtimes follow redirects whatever `manual` says, so the final address is checked as well. The
  // phone's fetch is `expo/fetch`, which really does not follow them; this is the second line.
  if (
    response.status < 200 ||
    (response.status >= 300 && response.status < 400) ||
    response.redirected ||
    isOtherOrigin(response.url, origin)
  ) {
    throw protocol(response.status, "redirect");
  }
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (response.status >= 300) {
    const code =
      typeof json === "object" &&
      json !== null &&
      typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : undefined;
    throw new RegistryError("rejected", response.status, code);
  }
  return { status: response.status, json };
}

const decoded = <A>(decode: (value: unknown) => A, value: unknown): A => {
  try {
    return decode(value);
  } catch {
    throw protocol();
  }
};

export async function fetchRegistryInfo(env: RegistryEnvironment, origin: string) {
  const { json } = await send(env, { origin, method: "GET", path: "/v1/info" });
  return decoded(decodeInfo, json);
}

export async function joinRegistry(
  env: RegistryEnvironment,
  input: {
    readonly origin: string;
    /** `<id>.<secret>`, as `redemptionOf` spells it. */
    readonly invite: string;
    readonly key: DeviceKeyPair;
    readonly name: string;
  },
) {
  const { json } = await send(env, {
    origin: input.origin,
    method: "POST",
    path: "/v1/join",
    body: {
      invite: input.invite,
      device: { name: input.name, kind: "phone", jwk: input.key.jwk },
    },
    proof: { jwk: input.key.jwk, privateKey: input.key.privateKey },
  });
  return decoded(decodeJoin, json);
}

/** Always the registry's current list: `online` and the sync times change without `rev` moving. */
export async function listRegistryDevices(
  env: RegistryEnvironment,
  target: RegistryTarget,
): Promise<RegistryDevicesResponse> {
  const result = await send(env, {
    origin: target.origin,
    method: "GET",
    path: "/v1/devices",
    proof: { kid: target.key.id, privateKey: target.key.privateKey },
  });
  const body = decoded(decodeDevices, result.json);
  // Another registry answering at this address is discarded, not believed (design Q11, pinning).
  if (body.registryId !== target.registryId) throw protocol(undefined, "registry_mismatch");
  return body;
}
