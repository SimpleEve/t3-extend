import { describe, expect, it } from "vite-plus/test";

import { validatePushEndpoint } from "./pushEndpoint.ts";

describe("validatePushEndpoint", () => {
  it.each([
    ["https://ntfy.example.com/upAbCd?up=1", "ntfy.example.com"],
    ["https://ntfy.example.com:8443/upAbCd", "ntfy.example.com:8443"],
    ["https://192.168.1.20/upAbCd", "192.168.1.20"],
  ])("accepts %s and reports only the host", (url, host) => {
    expect(validatePushEndpoint(url, { allowInsecure: false })?.host).toBe(host);
  });

  it.each([
    "http://ntfy.example.com/upAbCd",
    "https://user:secret@ntfy.example.com/upAbCd",
    "https://localhost/upAbCd",
    "https://127.0.0.1/upAbCd",
    "https://[::1]/upAbCd",
    "https://169.254.169.254/latest/meta-data",
    "ftp://ntfy.example.com/upAbCd",
    "not a url",
  ])("rejects %s", (url) => {
    expect(validatePushEndpoint(url, { allowInsecure: false })).toBeNull();
  });

  it("allows plain http on loopback only when explicitly enabled", () => {
    expect(
      validatePushEndpoint("http://127.0.0.1:8080/upAbCd", { allowInsecure: true })?.host,
    ).toBe("127.0.0.1:8080");
  });
});
