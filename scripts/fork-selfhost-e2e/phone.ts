// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - the phone's protocol, without a phone.
// A phone as the protocol sees it: a P-256 device key (memory only, no SecureStore), the registry
// requests signed with it, and passes exchanged for DPoP sessions. The same shared library the app uses.
import * as NodeCrypto from "node:crypto";

import { ORCHESTRATION_PROTOCOL_VERSION, T3X_DEVICE_TOKEN_PATH } from "@t3tools/contracts";
import { computeDpopAccessTokenHash, computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import type { DpopPublicJwk } from "@t3tools/shared/dpop";
import { signAssertion } from "@t3tools/shared/forkDeviceKeys/assertion";
import { decodeInvite, redemptionOf } from "@t3tools/shared/forkDeviceKeys/invite";
import { generateDeviceKey, type DeviceKeyPair } from "@t3tools/shared/forkDeviceKeys/jws";
import { canonicalOrigin, signRequestProof } from "@t3tools/shared/forkDeviceKeys/proof";

import { check, E2eFailure, httpRequest, type HttpResult } from "./util.ts";

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A DPoP key pair that makes proofs; the session a pass is exchanged for is bound to its thumbprint. */
export class DpopKey {
  readonly #privateKey: NodeCrypto.KeyObject;
  readonly jwk: DpopPublicJwk;
  readonly thumbprint: string;

  constructor() {
    const pair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privateKey = pair.privateKey;
    this.jwk = pair.publicKey.export({ format: "jwk" }) as DpopPublicJwk;
    this.thumbprint = computeDpopJwkThumbprint(this.jwk);
  }

  proof(input: { method: string; url: string; accessToken?: string; jti?: string }): string {
    const header = Buffer.from(
      JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: this.jwk }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        htm: input.method,
        htu: input.url,
        jti: input.jti ?? NodeCrypto.randomBytes(16).toString("base64url"),
        iat: nowSeconds(),
        ...(input.accessToken === undefined
          ? {}
          : { ath: computeDpopAccessTokenHash(input.accessToken) }),
      }),
    ).toString("base64url");
    const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: this.#privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }
}

export interface RegistryDeviceEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: "computer" | "phone";
  readonly subdomain?: string;
  readonly url?: string;
  readonly environmentId?: string;
  readonly online?: boolean;
}

export interface PassOptions {
  readonly audienceEnvironmentId: string;
  readonly dpopThumbprint?: string;
  readonly lifetimeSeconds?: number;
}

export class Phone {
  readonly name: string;
  readonly registryOrigin: string;
  readonly registryId: string;
  readonly key: DeviceKeyPair;
  readonly dpop = new DpopKey();
  /** The device list as of the last `manifest()`: what a phone has when the server is out of reach. */
  cached: ReadonlyArray<RegistryDeviceEntry> = [];

  private constructor(input: {
    name: string;
    registryOrigin: string;
    registryId: string;
    key: DeviceKeyPair;
  }) {
    this.name = input.name;
    this.registryOrigin = input.registryOrigin;
    this.registryId = input.registryId;
    this.key = input.key;
  }

  get id(): string {
    return this.key.id;
  }

  /** Redeems a phone invite: the unsigned-by-id join request, carrying the public key instead of a `kid`. */
  static async join(inviteText: string, name: string): Promise<Phone> {
    const invite = decodeInvite(inviteText);
    check(invite !== null, "The phone invite could not be decoded.");
    check(invite.kind === "phone" || invite.kind === "any", `The invite is for a ${invite.kind}.`);
    const key = generateDeviceKey();
    const body = JSON.stringify({
      invite: redemptionOf(invite),
      device: { name, kind: "phone", jwk: key.jwk },
    });
    const response = await httpRequest(`${invite.origin}/v1/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "t3x-proof": signRequestProof({
          privateKey: key.privateKey,
          jwk: key.jwk,
          method: "POST",
          htu: `${canonicalOrigin(invite.origin)}/v1/join`,
          body: new TextEncoder().encode(body),
          iat: nowSeconds(),
        }),
      },
      body,
    });
    if (response.status !== 201) {
      throw new E2eFailure(`Phone join answered ${response.status}: ${response.text}`);
    }
    const joined = response.json() as { registryId: string };
    return new Phone({ name, registryOrigin: invite.origin, registryId: joined.registryId, key });
  }

  /** A signed registry request. */
  async registry(method: string, path: string, json?: unknown): Promise<HttpResult> {
    const body = json === undefined ? undefined : JSON.stringify(json);
    return httpRequest(`${this.registryOrigin}${path}`, {
      method,
      headers: {
        "t3x-proof": signRequestProof({
          privateKey: this.key.privateKey,
          kid: this.key.id,
          method,
          htu: `${canonicalOrigin(this.registryOrigin)}${path}`,
          body: body === undefined ? new Uint8Array() : new TextEncoder().encode(body),
          iat: nowSeconds(),
        }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
  }

  async manifest(): Promise<ReadonlyArray<RegistryDeviceEntry>> {
    const response = await this.registry("GET", "/v1/devices");
    check(response.status === 200, `GET /v1/devices answered ${response.status}: ${response.text}`);
    this.cached = (response.json() as { devices: ReadonlyArray<RegistryDeviceEntry> }).devices;
    return this.cached;
  }

  /** A signed pass for one computer; `dpopThumbprint` defaults to this phone's session key. */
  pass(options: PassOptions): string {
    return signAssertion({
      privateKey: this.key.privateKey,
      deviceId: this.key.id,
      audienceEnvironmentId: options.audienceEnvironmentId,
      registryId: this.registryId,
      dpopThumbprint: options.dpopThumbprint ?? this.dpop.thumbprint,
      iat: nowSeconds(),
      lifetimeSeconds: options.lifetimeSeconds ?? 60,
    }).assertion;
  }

  exchange(
    origin: string,
    assertion: string,
    extra: { headers?: Record<string, string>; dpop?: DpopKey } = {},
  ) {
    return exchangePass(origin, assertion, extra.dpop ?? this.dpop, extra.headers);
  }

  /** Pass, exchange, and the session's access token. */
  async login(
    origin: string,
    audienceEnvironmentId: string,
  ): Promise<{ accessToken: string; scope: string }> {
    return sessionOf(await this.exchange(origin, this.pass({ audienceEnvironmentId })), origin);
  }

  webSocketUrl(origin: string, accessToken: string): Promise<string> {
    return sessionSocketUrl(origin, accessToken, this.dpop);
  }
}

/** POST a pass at `origin` (a tunnel URL, or a computer's own address) with a DPoP proof for that URL. */
export function exchangePass(
  origin: string,
  assertion: string,
  dpop: DpopKey,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const url = `${origin}${T3X_DEVICE_TOKEN_PATH}`;
  return httpRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      dpop: dpop.proof({ method: "POST", url }),
      ...headers,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
}

/** The access token of a successful exchange; anything else fails with the answer. */
export function sessionOf(
  response: HttpResult,
  origin: string,
): { accessToken: string; scope: string } {
  if (response.status !== 200) {
    throw new E2eFailure(
      `Pass exchange at ${origin} answered ${response.status} (${String(response.headers["t3x-reason"] ?? "no reason")}): ${response.text}`,
    );
  }
  const session = response.json() as { access_token: string; token_type: string; scope: string };
  check(
    session.token_type === "DPoP",
    `A pass must give a DPoP session, got ${session.token_type}.`,
  );
  return { accessToken: session.access_token, scope: session.scope };
}

/** A WebSocket ticket for a DPoP session, and the URL (with the upgrade's own DPoP proof) to open. */
export async function sessionSocketUrl(
  origin: string,
  accessToken: string,
  dpop: DpopKey,
): Promise<string> {
  const ticketUrl = `${origin}/api/auth/websocket-ticket/rpc`;
  const response = await httpRequest(ticketUrl, {
    method: "POST",
    headers: {
      authorization: `DPoP ${accessToken}`,
      dpop: dpop.proof({ method: "POST", url: ticketUrl, accessToken }),
    },
  });
  check(response.status === 200, `websocket ticket answered ${response.status}: ${response.text}`);
  const ticket = (response.json() as { ticket: string }).ticket;
  const upgrade = dpop.proof({ method: "GET", url: `${origin}/ws`, accessToken: ticket });
  return `${origin.replace(/^http/u, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}&dpop=${encodeURIComponent(upgrade)}`;
}
