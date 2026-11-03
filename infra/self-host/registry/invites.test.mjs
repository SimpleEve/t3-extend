import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { decodeInvite, encodeInvite, parseRedemption } from "./invites.mjs";
import { b64u } from "./proof.mjs";

const assert = NodeAssert;
const { describe, it } = NodeTest;

const fields = {
  origin: "https://t3.example.com",
  registryId: "abcdefg2",
  id: "AAAAAAAAAAA",
  secret: "BBBBBBBBBBBBBBBBBBBBBB",
  kind: "phone",
  expiresAt: 1_800_000_900,
};

describe("invite strings", () => {
  it("round-trips and stays around 200 characters", () => {
    const text = encodeInvite(fields);
    assert.ok(text.startsWith("t3x1."));
    assert.ok(text.length < 240, String(text.length));
    assert.deepEqual(decodeInvite(text), fields);
    for (const kind of ["computer", "phone", "any"])
      assert.equal(decodeInvite(encodeInvite({ ...fields, kind })).kind, kind);
  });

  it("rejects wrong versions, truncation, pollution and wrong shapes", () => {
    const wrap = (payload) => `t3x1.${b64u.encode(JSON.stringify(payload))}`;
    const payload = {
      v: 1,
      o: fields.origin,
      r: fields.registryId,
      i: fields.id,
      s: fields.secret,
      k: "p",
      e: fields.expiresAt,
    };
    const good = encodeInvite(fields);
    const bad = [
      "",
      "t3x2." + good.slice(5),
      good.slice(0, -4),
      `${good}=`,
      `${good}!`,
      "t3x1.",
      wrap({ ...payload, v: 2 }),
      wrap({ ...payload, k: "x" }),
      wrap({ ...payload, i: "short" }),
      wrap({ ...payload, s: "short" }),
      wrap({ ...payload, r: "UPPERCAS" }),
      wrap({ ...payload, o: "https://" + "a".repeat(80) }),
      wrap({ ...payload, e: "soon" }),
      wrap([]),
      `t3x1.${b64u.encode("not json")}`,
    ];
    for (const text of bad) assert.equal(decodeInvite(text), null, text.slice(0, 30));
    assert.equal(decodeInvite(7), null);
  });

  it("parses the i.s pair a device sends", () => {
    assert.deepEqual(parseRedemption("AAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB"), {
      id: "AAAAAAAAAAA",
      secret: "BBBBBBBBBBBBBBBBBBBBBB",
    });
    for (const bad of [
      "",
      "x",
      "a.b",
      "AAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.C",
      "AAAAAAAAAAA BBBBBBBBBBBBBBBBBBBBBB",
      3,
    ]) {
      assert.equal(parseRedemption(bad), null, String(bad));
    }
  });
});
