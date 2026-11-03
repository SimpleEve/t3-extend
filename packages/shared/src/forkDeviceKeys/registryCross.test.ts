// The registry (plain Node, zero dependencies) and this library are written twice on purpose;
// these vectors fail the moment either side drifts. Registry code is loaded by path so it stays
// outside the TypeScript project.
import { assert, describe, it } from "@effect/vitest";

import { decodeInvite, encodeInvite } from "./invite.ts";
import { INVITE_PREFIX } from "./invite.ts";
import {
  b64u,
  decodeJws,
  deviceIdOf,
  generateDeviceKey,
  normalizeJwk,
  verifyJwsSignature,
} from "./jws.ts";
import { signRequestProof, signTicket, verifyRequestProof } from "./proof.ts";
import { deriveSubdomainBase, normalizeDeviceName } from "./subdomain.ts";

type Jwk = ReturnType<typeof generateDeviceKey>["jwk"];
interface RegistryProof {
  generateDeviceKey: () => { privateKey: unknown; jwk: Jwk; id: string };
  jwkThumbprint: (jwk: Jwk) => string;
  normalizeJwk: (jwk: unknown) => Jwk | null;
  publicKeyFromJwk: (jwk: Jwk) => unknown;
  signRequestProof: (input: Record<string, unknown>) => string;
  parseRequestProof: (token: string) => unknown;
  verifyRequestProof: (decoded: unknown, input: Record<string, unknown>) => { jti: string };
  signTicket: (input: Record<string, unknown>) => string;
  decodeJws: (token: string) => unknown;
  verifyJwsSignature: (decoded: unknown, key: unknown) => boolean;
}
interface RegistryInvites {
  encodeInvite: (input: Record<string, unknown>) => string;
  decodeInvite: (text: string) => Record<string, unknown> | null;
}
interface RegistrySubdomain {
  deriveSubdomainBase: (name: string) => string;
  normalizeDeviceName: (name: unknown) => string | null;
}

const load = async <T>(file: string): Promise<T> =>
  (await import(
    /* @vite-ignore */ new URL(`../../../../infra/self-host/registry/${file}`, import.meta.url).href
  )) as T;

const HTU = "https://t3.example.com/v1/invites";
const BODY = new TextEncoder().encode('{"kind":"phone"}');
const NOW = 1_800_000_000;

describe("shared library and registry proof.mjs agree", () => {
  it("fingerprints and normalises keys identically, in both directions", async () => {
    const registry = await load<RegistryProof>("proof.mjs");
    const theirs = registry.generateDeviceKey();
    assert.equal(deviceIdOf(theirs.jwk), theirs.id);
    const ours = generateDeviceKey();
    assert.equal(registry.jwkThumbprint(ours.jwk), ours.id);
    for (const candidate of [
      ours.jwk,
      { ...ours.jwk, d: "x" },
      { ...ours.jwk, crv: "P-384" },
      { ...ours.jwk, y: theirs.jwk.x },
      null,
    ]) {
      assert.deepEqual(normalizeJwk(candidate), registry.normalizeJwk(candidate));
    }
  });

  it("shared signs a request, registry verifies (with and without a body)", async () => {
    const registry = await load<RegistryProof>("proof.mjs");
    const key = generateDeviceKey();
    for (const body of [BODY, new Uint8Array()]) {
      const token = signRequestProof({
        privateKey: key.privateKey,
        kid: key.id,
        method: "POST",
        htu: HTU,
        body,
        iat: NOW,
      });
      const decoded = registry.parseRequestProof(token);
      const proven = registry.verifyRequestProof(decoded, {
        publicKey: registry.publicKeyFromJwk(key.jwk),
        method: "POST",
        htu: HTU,
        now: NOW,
        body: Buffer.from(body),
      });
      assert.match(proven.jti, /^[A-Za-z0-9_-]{22}$/);
    }
    // POST /v1/join signs with the public key in the header instead of a kid.
    const join = signRequestProof({
      privateKey: key.privateKey,
      jwk: key.jwk,
      method: "POST",
      htu: HTU,
      body: BODY,
      iat: NOW,
    });
    const header = (registry.parseRequestProof(join) as { header: { jwk: Jwk; kid?: string } })
      .header;
    assert.deepEqual(header.jwk, key.jwk);
    assert.equal(header.kid, undefined);
  });

  it("registry signs a request, shared verifies", async () => {
    const registry = await load<RegistryProof>("proof.mjs");
    const theirs = registry.generateDeviceKey();
    const token = registry.signRequestProof({
      privateKey: theirs.privateKey,
      kid: theirs.id,
      method: "POST",
      htu: HTU,
      body: Buffer.from(BODY),
      iat: NOW,
    });
    assert.match(
      verifyRequestProof(token, { jwk: theirs.jwk, method: "POST", htu: HTU, now: NOW, body: BODY })
        .jti,
      /^[A-Za-z0-9_-]{22}$/,
    );
  });

  it("tickets signed by one side verify on the other", async () => {
    const registry = await load<RegistryProof>("proof.mjs");
    const ours = generateDeviceKey();
    const fields = { rid: "abcdefgh", sub: "mac", gen: 3, iat: NOW };
    const theirTicketOfOurs = registry.decodeJws(
      signTicket({ privateKey: ours.privateKey, kid: ours.id, ...fields }),
    );
    assert.equal(
      registry.verifyJwsSignature(theirTicketOfOurs, registry.publicKeyFromJwk(ours.jwk)),
      true,
    );
    const theirs = registry.generateDeviceKey();
    const ourDecode = decodeJws(
      registry.signTicket({ privateKey: theirs.privateKey, kid: theirs.id, ...fields }),
    );
    assert.equal(verifyJwsSignature(ourDecode, theirs.jwk), true);
    assert.equal(ourDecode.header.typ, "t3x-ticket+jwt");
  });

  it("invite strings, names and subdomain bases round-trip across the two implementations", async () => {
    const invites = await load<RegistryInvites>("invites.mjs");
    const subdomains = await load<RegistrySubdomain>("subdomain.mjs");
    const invite = {
      origin: "https://t3.example.com",
      registryId: "abcdefgh",
      id: "AAAAAAAAAAA",
      secret: "BBBBBBBBBBBBBBBBBBBBBB",
      kind: "any",
      expiresAt: NOW,
    } as const;
    assert.equal(encodeInvite(invite), invites.encodeInvite(invite));
    assert.deepEqual(invites.decodeInvite(encodeInvite(invite)), invite);
    assert.deepEqual(decodeInvite(invites.encodeInvite(invite)), invite);
    assert.isTrue(invites.encodeInvite(invite).startsWith(INVITE_PREFIX));
    assert.equal(decodeInvite(`${INVITE_PREFIX}${b64u.encode("{}")}`), null);
    assert.equal(invites.decodeInvite(`${INVITE_PREFIX}${b64u.encode("{}")}`), null);

    for (const name of ["Eve's MacBook Pro", "---mac---", "a".repeat(35), "Mac mini (2)", "Zoë"]) {
      assert.equal(deriveSubdomainBase(name), subdomains.deriveSubdomainBase(name));
    }
    for (const name of ["Mac", "我的 Mac", "", "x".repeat(41), "a\nb", " pad "]) {
      assert.equal(normalizeDeviceName(name), subdomains.normalizeDeviceName(name));
    }
  });
});
