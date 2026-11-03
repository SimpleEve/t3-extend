// @effect-diagnostics nodeBuiltinImport:off -- Node's own crypto is the independent oracle here.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import {
  ASSERTION_MAX_LIFETIME_SECONDS,
  parseAssertion,
  signAssertion,
  verifyAssertionSignature,
} from "./assertion.ts";
import { INVITE_PREFIX, decodeInvite, encodeInvite, redemptionOf } from "./invite.ts";
import {
  ProofError,
  b64u,
  decodeJws,
  deviceIdOf,
  generateDeviceKey,
  normalizeJwk,
  signJws,
  verifyJwsSignature,
} from "./jws.ts";
import { canonicalOrigin, signRequestProof, signTicket, verifyRequestProof } from "./proof.ts";
import { deriveSubdomainBase, isReservedSubdomain, normalizeDeviceName } from "./subdomain.ts";

const throwsProofError = (run: () => unknown, reason?: string) => {
  try {
    run();
  } catch (error) {
    assert.instanceOf(error, ProofError);
    if (reason !== undefined) assert.equal((error as ProofError).reason, reason);
    return;
  }
  assert.fail("expected a ProofError");
};

describe("device keys", () => {
  it("derives the RFC 7638 thumbprint as the device id, and rejects anything but a P-256 key", () => {
    const key = generateDeviceKey();
    const oracle = NodeCrypto.createHash("sha256")
      .update(JSON.stringify({ crv: "P-256", kty: "EC", x: key.jwk.x, y: key.jwk.y }))
      .digest("base64url");
    assert.equal(key.id, oracle);
    assert.equal(deviceIdOf(key.jwk), oracle);
    assert.deepEqual(normalizeJwk(key.jwk), key.jwk);

    const other = generateDeviceKey().jwk;
    for (const bad of [
      { ...key.jwk, d: "x" },
      { ...key.jwk, crv: "P-384" },
      { ...key.jwk, kty: "OKP" },
      { kty: "EC", crv: "P-256", x: key.jwk.x },
      { ...key.jwk, x: b64u.encode(new Uint8Array(31)) },
      // A point that is not on the curve.
      { ...key.jwk, y: other.x },
      { ...key.jwk, x: `${key.jwk.x}=` },
      null,
      "jwk",
    ]) {
      assert.equal(normalizeJwk(bad), null);
    }
  });

  it("round-trips ES256 JWS and refuses malformed or tampered tokens", () => {
    const key = generateDeviceKey();
    const token = signJws({ alg: "ES256", kid: key.id }, { a: 1 }, key.privateKey);
    const decoded = decodeJws(token);
    assert.equal(verifyJwsSignature(decoded, key.jwk), true);
    assert.equal(verifyJwsSignature(decoded, generateDeviceKey().jwk), false);
    // The signature must be Node-verifiable too (r||s, 64 bytes).
    assert.equal(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(decoded.signingInput),
        {
          key: NodeCrypto.createPublicKey({ key: { ...key.jwk }, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(decoded.signature),
      ),
      true,
    );
    const [header, payload, signature] = token.split(".") as [string, string, string];
    for (const bad of [
      `${header}.${payload}`,
      `${header}.${payload}.${signature}.x`,
      `${header}.${payload}.${signature.slice(0, -4)}`,
      `${header}.${b64u.encode("[]")}.${signature}`,
      `${header}.${payload}=.${signature}`,
      "",
    ]) {
      throwsProofError(() => decodeJws(bad), "malformed");
    }
    throwsProofError(() => decodeJws("x".repeat(5000)), "malformed");
    const swapped = decodeJws(`${header}.${b64u.encode('{"a":2}')}.${signature}`);
    assert.equal(verifyJwsSignature(swapped, key.jwk), false);
  });

  it("decodes base64url only in its canonical, unpadded form", () => {
    assert.deepEqual(Array.from(b64u.decode("AQID") ?? []), [1, 2, 3]);
    for (const bad of ["AQID=", "AQ=", "A", "AQJ", "AQ+/", " AQID", 5]) {
      assert.equal(b64u.decode(bad), null);
    }
  });
});

describe("invites", () => {
  const invite = {
    origin: "https://t3.example.com",
    registryId: "abcdefgh",
    id: "AAAAAAAAAAA",
    secret: "BBBBBBBBBBBBBBBBBBBBBB",
    kind: "computer",
    expiresAt: 1_800_000_000,
  } as const;

  it("encodes and decodes the same string the registry prints", () => {
    const text = encodeInvite(invite);
    assert.isTrue(text.startsWith(INVITE_PREFIX));
    assert.deepEqual(decodeInvite(text), invite);
    assert.equal(redemptionOf(invite), "AAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB");
  });

  it("rejects other versions, truncation, pollution and out-of-range fields", () => {
    const text = encodeInvite(invite);
    const forge = (patch: Record<string, unknown>) =>
      `${INVITE_PREFIX}${b64u.encode(JSON.stringify({ v: 1, o: invite.origin, r: invite.registryId, i: invite.id, s: invite.secret, k: "c", e: invite.expiresAt, ...patch }))}`;
    for (const bad of [
      text.slice(0, -3),
      `${text}=`,
      text.replace(INVITE_PREFIX, "t3x2."),
      forge({ v: 2 }),
      forge({ k: "x" }),
      forge({ r: "ABCDEFGH" }),
      forge({ i: "short" }),
      forge({ s: "short" }),
      forge({ o: `https://${"a".repeat(80)}.example` }),
      forge({ e: "soon" }),
      "t3x1.!!!",
      42,
    ]) {
      assert.equal(decodeInvite(bad), null);
    }
  });
});

describe("assertions", () => {
  const device = generateDeviceKey();
  const sign = (overrides: Partial<Parameters<typeof signAssertion>[0]> = {}) =>
    signAssertion({
      privateKey: device.privateKey,
      deviceId: device.id,
      audienceEnvironmentId: "env-1",
      registryId: "abcdefgh",
      dpopThumbprint: "t".repeat(43),
      iat: 1000,
      ...overrides,
    });

  it("binds device, computer, registry and DPoP key, and expires after two minutes", () => {
    const { assertion, expiresAt } = sign();
    assert.equal(expiresAt, 1000 + ASSERTION_MAX_LIFETIME_SECONDS);
    const parsed = parseAssertion(assertion);
    assert.equal(parsed.kid, device.id);
    assert.deepEqual(
      { ...parsed.claims, jti: undefined },
      {
        iss: device.id,
        sub: device.id,
        aud: "env-1",
        rid: "abcdefgh",
        iat: 1000,
        exp: 1120,
        jti: undefined,
        jkt: "t".repeat(43),
      },
    );
    assert.equal(verifyAssertionSignature(parsed, device.jwk), true);
    assert.equal(verifyAssertionSignature(parsed, generateDeviceKey().jwk), false);
    assert.equal(sign({ lifetimeSeconds: 60 }).expiresAt, 1060);
  });

  it("refuses passes with the wrong type, a missing binding or non-integer times", () => {
    const wrongType = signJws(
      { alg: "ES256", typ: "dpop+jwt", kid: device.id },
      {},
      device.privateKey,
    );
    throwsProofError(() => parseAssertion(wrongType), "bad_header");
    const base = {
      v: 1,
      iss: "a",
      sub: "a",
      aud: "e",
      rid: "r",
      iat: 1,
      exp: 2,
      jti: "j",
      cnf: { jkt: "k" },
    };
    const forge = (patch: Record<string, unknown>) =>
      signJws(
        { alg: "ES256", typ: "t3x-assertion+jwt", kid: "a" },
        { ...base, ...patch },
        device.privateKey,
      );
    parseAssertion(forge({}));
    for (const patch of [
      { cnf: {} },
      { cnf: "k" },
      { iat: 1.5 },
      { exp: "2" },
      { v: 2 },
      { aud: 5 },
    ]) {
      throwsProofError(() => parseAssertion(forge(patch)), "bad_payload");
    }
  });
});

describe("T3X-Proof, origins and tickets", () => {
  const key = generateDeviceKey();
  const htu = "https://t3.example.com/v1/devices";
  const body = new TextEncoder().encode('{"kind":"phone"}');
  const verify = (token: string, patch: Partial<Parameters<typeof verifyRequestProof>[1]> = {}) =>
    verifyRequestProof(token, { jwk: key.jwk, method: "POST", htu, now: 5000, body, ...patch });

  it("verifies method, URL, time window and body hash", () => {
    const token = signRequestProof({
      privateKey: key.privateKey,
      kid: key.id,
      method: "POST",
      htu,
      body,
      iat: 5000,
    });
    assert.match(verify(token).jti, /^[A-Za-z0-9_-]{22}$/);
    throwsProofError(() => verify(token, { method: "GET" }), "method_mismatch");
    throwsProofError(() => verify(token, { htu: `${htu}?x=1` }), "htu_mismatch");
    throwsProofError(() => verify(token, { now: 5121 }), "time_window");
    throwsProofError(() => verify(token, { now: 4879 }), "time_window");
    throwsProofError(() => verify(token, { body: new Uint8Array([1]) }), "bh_mismatch");
    throwsProofError(() => verify(token, { body: new Uint8Array() }), "bh_mismatch");
    throwsProofError(() => verify(token, { jwk: generateDeviceKey().jwk }), "bad_signature");
    const bodiless = signRequestProof({
      privateKey: key.privateKey,
      kid: key.id,
      method: "POST",
      htu,
      iat: 5000,
    });
    throwsProofError(() => verify(bodiless), "bh_mismatch");
  });

  it("canonicalises the registry origin and refuses anything that is not a bare https origin", () => {
    assert.equal(canonicalOrigin("HTTPS://T3.Example.COM"), "https://t3.example.com");
    assert.equal(canonicalOrigin("https://t3.example.com:443/"), "https://t3.example.com");
    assert.equal(canonicalOrigin("https://t3.example.com:8443"), "https://t3.example.com:8443");
    assert.equal(canonicalOrigin("https://bücher.example"), "https://xn--bcher-kva.example");
    for (const bad of [
      "http://t3.example.com",
      "https://t3.example.com/path",
      "https://t3.example.com?x=1",
      "https://u:p@t3.example.com",
      "https://t3.example.com#x",
      "not a url",
    ]) {
      assert.throws(() => canonicalOrigin(bad));
    }
  });

  it("signs a tunnel ticket bound to the device, subdomain and registration generation", () => {
    const decoded = decodeJws(
      signTicket({
        privateKey: key.privateKey,
        kid: key.id,
        rid: "abcdefgh",
        sub: "mac",
        gen: 7,
        iat: 100,
      }),
    );
    assert.deepEqual(decoded.payload, {
      v: 1,
      iss: key.id,
      rid: "abcdefgh",
      sub: "mac",
      gen: 7,
      iat: 100,
      exp: 86500,
    });
    assert.equal(decoded.header.typ, "t3x-ticket+jwt");
  });
});

describe("names and subdomains", () => {
  it("normalises display names", () => {
    assert.equal(normalizeDeviceName("  Café ́"), "Café ́".normalize("NFC").trim());
    assert.equal(normalizeDeviceName("我的 Mac"), "我的 Mac");
    assert.equal(normalizeDeviceName("a".repeat(40))?.length, 40);
    for (const bad of ["", "   ", "a".repeat(41), "tab\there", "line break", 7]) {
      assert.equal(normalizeDeviceName(bad), null);
    }
  });

  it("derives a subdomain base, falling back for names with nothing usable", () => {
    const fallback = () => "abcd";
    for (const [name, expected] of [
      ["Eve's MacBook Pro", "eve-s-macbook-pro"],
      ["---mac---", "mac"],
      ["我的电脑", "computer-abcd"],
      ["🙂🙂", "computer-abcd"],
      ["a".repeat(31), "a".repeat(30)],
      [`${"a".repeat(29)} b`, "a".repeat(29)],
    ] as const) {
      assert.equal(deriveSubdomainBase(name, fallback), expected);
    }
    for (const reserved of [
      "ntfy",
      "www",
      "api",
      "registry",
      "frp",
      "admin",
      "mail",
      "t3x",
      "_x",
      "xn--a",
    ]) {
      assert.equal(isReservedSubdomain(reserved), true);
    }
    assert.equal(isReservedSubdomain("mac"), false);
  });
});
