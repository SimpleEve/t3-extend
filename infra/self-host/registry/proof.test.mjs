import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeTest from "node:test";

import {
  ProofError,
  b64u,
  bodyHash,
  canonicalOrigin,
  decodeJws,
  generateDeviceKey,
  jwkThumbprint,
  normalizeJwk,
  originParts,
  parseRequestProof,
  publicKeyFromJwk,
  signJws,
  signRequestProof,
  signTicket,
  verifyJwsSignature,
  verifyRequestProof,
} from "./proof.mjs";

const assert = NodeAssert;
const { generateKeyPairSync } = NodeCrypto;
const { describe, it } = NodeTest;

// RFC 7515 appendix A.3: an ES256 key and a JWS made by someone else's implementation.
const RFC_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};
const RFC_JWS =
  "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q";
// SHA-256 of the RFC 7638 member string, computed outside this code base.
const RFC_JWK_THUMBPRINT = "oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U";

const NOW = 1_800_000_000;
const HTU = "https://registry.test/v1/devices";

describe("device keys", () => {
  it("matches an independently computed RFC 7638 thumbprint", () => {
    assert.equal(jwkThumbprint(normalizeJwk(RFC_JWK)), RFC_JWK_THUMBPRINT);
  });

  it("verifies a JWS produced by another implementation", () => {
    const decoded = decodeJws(RFC_JWS);
    assert.equal(verifyJwsSignature(decoded, publicKeyFromJwk(normalizeJwk(RFC_JWK))), true);
    const other = generateDeviceKey();
    assert.equal(verifyJwsSignature(decoded, publicKeyFromJwk(other.jwk)), false);
  });

  it("accepts exactly the four JWK fields on the curve and nothing else", () => {
    assert.deepEqual(normalizeJwk({ ...RFC_JWK }), RFC_JWK);
    const wrongPoint = { ...RFC_JWK, y: RFC_JWK.x };
    const cases = {
      "extra field": { ...RFC_JWK, d: "AA" },
      "extra use": { ...RFC_JWK, use: "sig" },
      "missing y": { kty: "EC", crv: "P-256", x: RFC_JWK.x },
      "other curve": { ...RFC_JWK, crv: "P-384" },
      "other type": { ...RFC_JWK, kty: "OKP" },
      "not on the curve": wrongPoint,
      "padded base64": { ...RFC_JWK, x: `${RFC_JWK.x}=` },
      "short coordinate": { ...RFC_JWK, x: "AAAA" },
      "not an object": "jwk",
      array: [],
      null: null,
    };
    for (const [label, jwk] of Object.entries(cases)) assert.equal(normalizeJwk(jwk), null, label);
  });

  it("reads base64url strictly", () => {
    assert.equal(b64u.decode("AAAA")?.length, 3);
    for (const bad of ["AA==", "AA+A", "AA/A", "A", "AAAB=", " AAAA", "AAA\n"])
      assert.equal(b64u.decode(bad), null, bad);
    // A non-canonical tail (trailing bits set) would let two strings decode to the same bytes.
    assert.equal(b64u.decode("AB"), null);
    assert.equal(b64u.decode(1), null);
  });
});

describe("JWS", () => {
  it("round-trips and rejects any change to header, payload or signature", () => {
    const device = generateDeviceKey();
    const token = signJws({ alg: "ES256", kid: device.id }, { a: 1 }, device.privateKey);
    const decoded = decodeJws(token);
    assert.equal(verifyJwsSignature(decoded, publicKeyFromJwk(device.jwk)), true);

    const [header, payload, signature] = token.split(".");
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    const forged = [
      `${header}.${b64u.encode('{"a":2}')}.${signature}`,
      `${b64u.encode('{"alg":"ES256","kid":"x"}')}.${payload}.${signature}`,
      `${header}.${payload}.${flipped}`,
    ];
    for (const text of forged) {
      assert.equal(verifyJwsSignature(decodeJws(text), publicKeyFromJwk(device.jwk)), false);
    }
  });

  it("rejects tokens that are not three canonical segments with a 64-byte signature", () => {
    const device = generateDeviceKey();
    const good = signJws({ alg: "ES256" }, {}, device.privateKey);
    const [header, payload, signature] = good.split(".");
    const bad = [
      "",
      "a.b",
      `${good}.extra`,
      `${header}.${payload}.`,
      `${header}.${payload}.${b64u.encode(Buffer.alloc(63))}`,
      `${b64u.encode("[1]")}.${payload}.${signature}`,
      `${b64u.encode("not json")}.${payload}.${signature}`,
      `${header}=.${payload}.${signature}`,
      "x".repeat(5000),
    ];
    for (const text of bad) assert.throws(() => decodeJws(text), ProofError, text.slice(0, 20));
    assert.throws(() => decodeJws(undefined), ProofError);
  });
});

describe("canonical public origin", () => {
  it("lowercases, converts the host to punycode and drops the default port", () => {
    assert.equal(canonicalOrigin("HTTPS://T3.Example.COM"), "https://t3.example.com");
    assert.equal(canonicalOrigin("https://t3.example.com:443/"), "https://t3.example.com");
    assert.equal(canonicalOrigin("https://t3.localhost:18443"), "https://t3.localhost:18443");
    assert.equal(canonicalOrigin("https://例え.jp"), "https://xn--r8jz45g.jp");
    assert.deepEqual(originParts("https://t3.localhost:18443"), {
      host: "t3.localhost",
      port: 18443,
    });
    assert.deepEqual(originParts("https://t3.example.com"), { host: "t3.example.com", port: 443 });
  });

  it("refuses anything that is not a bare https origin", () => {
    for (const bad of [
      "",
      "t3.example.com",
      "http://t3.example.com",
      "https://t3.example.com/v1",
      "https://t3.example.com?x=1",
      "https://t3.example.com#x",
      "https://user@t3.example.com",
      "https://t3.example.com.",
      "https://",
    ]) {
      assert.throws(() => canonicalOrigin(bad), undefined, bad);
    }
  });
});

describe("T3X-Proof", () => {
  const device = generateDeviceKey();
  const publicKey = publicKeyFromJwk(device.jwk);
  const body = Buffer.from('{"kind":"phone"}');
  const sign = (overrides = {}) =>
    signRequestProof({
      privateKey: device.privateKey,
      kid: device.id,
      method: "GET",
      htu: HTU,
      iat: NOW,
      ...overrides,
    });
  const check = (token, overrides = {}) =>
    verifyRequestProof(parseRequestProof(token), {
      publicKey,
      method: "GET",
      htu: HTU,
      now: NOW,
      body: Buffer.alloc(0),
      ...overrides,
    });
  const reason = (fn) => {
    try {
      fn();
    } catch (error) {
      return error.reason;
    }
    return "accepted";
  };

  it("accepts a good proof and reports how long its jti must be remembered", () => {
    const result = check(sign());
    assert.equal(result.jti.length, 22);
    assert.equal(result.expiresAt, NOW + 240);
  });

  it("covers method, URL, time window and body hash", () => {
    assert.equal(
      reason(() => check(sign({ method: "POST" }))),
      "method_mismatch",
    );
    assert.equal(
      reason(() => check(sign({ htu: `${HTU}?x=1` }))),
      "htu_mismatch",
    );
    assert.equal(
      reason(() => check(sign({ htu: "https://evil.test/v1/devices" }))),
      "htu_mismatch",
    );
    assert.equal(
      reason(() => check(sign({ iat: NOW - 121 }))),
      "time_window",
    );
    assert.equal(
      reason(() => check(sign({ iat: NOW + 121 }))),
      "time_window",
    );
    assert.equal(
      reason(() => check(sign({ iat: NOW - 120 }))),
      "accepted",
    );
    assert.equal(
      reason(() => check(sign({ iat: NOW + 120 }))),
      "accepted",
    );
    assert.equal(
      reason(() => check(sign({ jti: "short" }))),
      "bad_jti",
    );
  });

  it("binds the request body", () => {
    const signed = sign({ method: "POST", body });
    assert.equal(
      reason(() => check(signed, { method: "POST", body })),
      "accepted",
    );
    assert.equal(
      reason(() => check(signed, { method: "POST", body: Buffer.from('{"kind":"computer"}') })),
      "bh_mismatch",
    );
    assert.equal(
      reason(() => check(signed, { method: "POST", body: Buffer.alloc(0) })),
      "unexpected_bh",
    );
    assert.equal(
      reason(() => check(sign({ method: "POST" }), { method: "POST", body })),
      "bh_mismatch",
    );
    assert.equal(bodyHash(body).length, 43);
  });

  it("rejects a signature from another key", () => {
    const stranger = generateDeviceKey();
    const token = signRequestProof({
      privateKey: stranger.privateKey,
      kid: device.id,
      method: "GET",
      htu: HTU,
      iat: NOW,
    });
    assert.equal(
      reason(() => check(token)),
      "bad_signature",
    );
  });

  it("requires the right header: kid or jwk, never both, typ and alg exact", () => {
    const base = { privateKey: device.privateKey, method: "GET", htu: HTU, iat: NOW };
    const payload = { htm: "GET", htu: HTU, iat: NOW, jti: "AAAAAAAAAAAAAAAAAAAAAA" };
    const headers = [
      { alg: "ES256", typ: "t3x-req+jwt" },
      { alg: "ES256", typ: "t3x-req+jwt", kid: device.id, jwk: device.jwk },
      { alg: "ES256", typ: "JWT", kid: device.id },
      { alg: "none", typ: "t3x-req+jwt", kid: device.id },
      { alg: "ES256", typ: "dpop+jwt", kid: device.id },
    ];
    for (const header of headers) {
      assert.equal(
        reason(() => parseRequestProof(signJws(header, payload, base.privateKey))),
        "bad_header",
        JSON.stringify(header),
      );
    }
    assert.equal(
      reason(() =>
        parseRequestProof(
          signJws(
            { alg: "ES256", typ: "t3x-req+jwt", kid: device.id },
            { ...payload, iat: "1" },
            base.privateKey,
          ),
        ),
      ),
      "bad_payload",
    );
    assert.equal(
      reason(() => parseRequestProof("nonsense")),
      "malformed",
    );
  });

  it("signs tickets with the layout the plugin expects", () => {
    const ticket = signTicket({
      privateKey: device.privateKey,
      kid: device.id,
      rid: "abcdefgh",
      sub: "mac",
      gen: NOW,
      iat: NOW,
    });
    const { header, payload } = decodeJws(ticket);
    assert.deepEqual(header, { alg: "ES256", typ: "t3x-ticket+jwt", kid: device.id });
    assert.deepEqual(payload, {
      v: 1,
      iss: device.id,
      rid: "abcdefgh",
      sub: "mac",
      gen: NOW,
      iat: NOW,
      exp: NOW + 86400,
    });
  });

  it("keeps working with keys produced by plain node:crypto", () => {
    const { privateKey, publicKey: nodePublic } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const jwk = normalizeJwk(nodePublic.export({ format: "jwk" }));
    const token = signRequestProof({
      privateKey,
      kid: jwkThumbprint(jwk),
      method: "GET",
      htu: HTU,
      iat: NOW,
    });
    assert.equal(
      reason(() =>
        verifyRequestProof(parseRequestProof(token), {
          publicKey: publicKeyFromJwk(jwk),
          method: "GET",
          htu: HTU,
          now: NOW,
          body: Buffer.alloc(0),
        }),
      ),
      "accepted",
    );
  });
});
