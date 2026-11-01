import { describe, expect, it } from "vite-plus/test";

import { normalizePublicUrl, parsePublicUrlList, parsePublicUrlsDocument } from "./selfHost.ts";

describe("normalizePublicUrl", () => {
  it.each([
    ["https://t3.example.com", "https://t3.example.com/"],
    [" https://T3.Example.com/ ", "https://t3.example.com/"],
    ["https://t3.example.com:8443/", "https://t3.example.com:8443/"],
    ["https://t3.example.com:443", "https://t3.example.com/"],
  ])("accepts %s", (input, expected) => {
    expect(normalizePublicUrl(input)).toBe(expected);
  });

  it.each([
    "http://t3.example.com",
    "t3.example.com",
    "https://t3.example.com/env-a/",
    "https://t3.example.com/?a=1",
    "https://t3.example.com/#token=x",
    "https://user:pass@t3.example.com/",
    "wss://t3.example.com/",
    "",
  ])("rejects %s", (input) => {
    expect(normalizePublicUrl(input)).toBeNull();
  });
});

describe("public URL sources", () => {
  it("reads the environment list, dropping invalid and duplicate entries", () => {
    expect(
      parsePublicUrlList("https://a.example.com, http://b.example.com https://a.example.com/"),
    ).toEqual(["https://a.example.com/"]);
  });

  it("treats a malformed saved document as empty", () => {
    expect(parsePublicUrlsDocument("{not json")).toEqual([]);
    expect(parsePublicUrlsDocument('{"urls":"https://a.example.com"}')).toEqual([]);
    expect(parsePublicUrlsDocument('{"urls":["https://a.example.com",3]}')).toEqual([
      "https://a.example.com/",
    ]);
  });
});
