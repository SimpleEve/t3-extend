import { encodeInvite } from "@t3tools/shared/forkDeviceKeys/invite";
import { describe, expect, it } from "vite-plus/test";

import { readInvite } from "./inviteReading.ts";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const seconds = (ms: number) => Math.floor(ms / 1000);

describe("reading a pasted invite", () => {
  const invite = (origin: string, kind: "computer" | "phone" | "any" = "computer", ttl = 900) =>
    encodeInvite({
      origin,
      registryId: "abcdefgh",
      id: "AAAAAAAAAAA",
      secret: "B".repeat(22),
      kind,
      expiresAt: seconds(NOW) + ttl,
    });

  it("names the server it points at and nothing else before the user confirms", () => {
    expect(readInvite(`  ${invite("https://T3.Example.com")}\n`, NOW)).toMatchObject({
      _tag: "ready",
      host: "t3.example.com",
      punycode: null,
    });
  });

  it("shows a name written with other letters beside its ASCII form", () => {
    expect(readInvite(invite("https://tе.example.com"), NOW)).toMatchObject({
      _tag: "ready",
      host: "tе.example.com",
      punycode: expect.stringMatching(/^xn--t-/),
    });
  });

  it.each([
    ["", "computer", "empty"],
    ["hello", "computer", "invalid"],
    ["t3x1.not-base64!", "computer", "invalid"],
    [invite("https://t3.example.com", "phone"), "computer", "wrong-kind"],
    [invite("https://t3.example.com", "computer"), "phone", "wrong-kind"],
    [invite("https://t3.example.com", "any"), "phone", "ready"],
    [invite("https://t3.example.com", "phone"), "phone", "ready"],
    [invite("https://t3.example.com", "computer", -1), "computer", "expired"],
    [invite("http://t3.example.com"), "computer", "invalid"],
    [invite("https://t3.example.com/path"), "computer", "invalid"],
  ] as const)("reads %s for a %s as %s", (text, joining, tag) => {
    expect(readInvite(text, NOW, joining)._tag).toBe(tag);
  });
});
