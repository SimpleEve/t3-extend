import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  allocateSubdomain,
  deriveSubdomainBase,
  isReservedSubdomain,
  nameCandidates,
  normalizeDeviceName,
} from "./subdomain.mjs";

const assert = NodeAssert;
const { describe, it } = NodeTest;

describe("device names", () => {
  it("normalises to NFC and enforces 1-40 code points without control characters", () => {
    assert.equal(normalizeDeviceName("Café"), "Café");
    assert.equal(normalizeDeviceName("  Mac  "), "Mac");
    assert.equal(normalizeDeviceName("😀".repeat(40))?.length, 80);
    assert.equal(normalizeDeviceName("😀".repeat(41)), null);
    for (const bad of ["", "   ", "a\nb", "a\u0000b", "a b", "a\u007fb", 5, null, undefined]) {
      assert.equal(normalizeDeviceName(bad), null, String(bad));
    }
  });

  it("appends (2), (3) and keeps the result within 40 code points", () => {
    const candidates = nameCandidates("Mac");
    assert.deepEqual(
      [candidates.next().value, candidates.next().value, candidates.next().value],
      ["Mac", "Mac (2)", "Mac (3)"],
    );
    const long = "x".repeat(40);
    const [, second] = nameCandidates(long);
    assert.equal([...second].length, 40);
    assert.ok(second.endsWith(" (2)"));
  });
});

describe("subdomains", () => {
  it("derives a lowercase DNS label", () => {
    const cases = [
      ["My MacBook Pro", "my-macbook-pro"],
      ["  --Mac--  ", "mac"],
      ["Mac_mini (office)", "mac-mini-office"],
      ["ÉCOLE", "cole"],
      ["a".repeat(45), "a".repeat(30)],
      ["ab-".repeat(15), "ab-ab-ab-ab-ab-ab-ab-ab-ab-ab"],
    ];
    for (const [name, expected] of cases) assert.equal(deriveSubdomainBase(name), expected, name);
  });

  it("falls back to computer-xxxx for names with no latin letters or digits", () => {
    for (const name of ["电脑", "😀", "---"])
      assert.match(deriveSubdomainBase(name), /^computer-[a-z2-7]{4}$/, name);
  });

  it("reserves infrastructure names", () => {
    for (const label of [
      "ntfy",
      "www",
      "api",
      "registry",
      "frp",
      "admin",
      "mail",
      "t3x",
      "_x",
      "xn--abc",
    ]) {
      assert.equal(isReservedSubdomain(label), true, label);
    }
    assert.equal(isReservedSubdomain("mac"), false);
  });

  it("walks base, base-2, base-3 and gives up after 20 attempts", () => {
    const taken = new Set(["mac", "mac-2"]);
    assert.equal(
      allocateSubdomain("Mac", (label) => taken.has(label)),
      "mac-3",
    );
    assert.equal(
      allocateSubdomain("api", () => false),
      "api-2",
    );
    assert.equal(
      allocateSubdomain("Mac", () => true),
      null,
    );
    let asked = 0;
    allocateSubdomain("Mac", () => {
      asked += 1;
      return true;
    });
    assert.equal(asked, 20);
  });
});
