import { describe, expect, it } from "vite-plus/test";

import { insecureEndpointsDecision, validatePushEndpoint } from "./pushEndpoint.ts";

const strict = { allowInsecure: false, localAddresses: () => ["93.184.216.99"] };

describe("validatePushEndpoint", () => {
  it.each([
    ["https://ntfy.example.com/upAbCd?up=1", "ntfy.example.com"],
    ["https://ntfy.example.com:8443/upAbCd", "ntfy.example.com:8443"],
    ["https://8.8.8.8/upAbCd", "8.8.8.8"],
    ["https://[2606:4700:4700::1111]/upAbCd", "[2606:4700:4700::1111]"],
  ])("accepts %s and reports only the host", (url, host) => {
    expect(validatePushEndpoint(url, strict)?.host).toBe(host);
  });

  it.each([
    "http://ntfy.example.com/upAbCd",
    "https://user:pass@ntfy.example.com/upAbCd",
    "https://localhost/upAbCd",
    "https://localhost./upAbCd",
    "https://push.localhost/upAbCd",
    "https://127.0.0.1/upAbCd",
    "https://2130706433/upAbCd",
    "https://0x7f.1/upAbCd",
    "https://[::1]/upAbCd",
    "https://[::ffff:127.0.0.1]/upAbCd",
    "https://[::ffff:7f00:1]/upAbCd",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/upAbCd",
    "https://192.168.1.20/upAbCd",
    "https://100.100.100.100/upAbCd",
    "https://[fd00::1]/upAbCd",
    "https://[fe80::1]/upAbCd",
    "https://93.184.216.99/upAbCd",
    "ftp://ntfy.example.com/upAbCd",
    "not a url",
  ])("rejects %s", (url) => {
    expect(validatePushEndpoint(url, strict)).toBeNull();
  });

  it("allows plain http on loopback only when explicitly enabled", () => {
    expect(
      validatePushEndpoint("http://127.0.0.1:8080/upAbCd", { allowInsecure: true })?.host,
    ).toBe("127.0.0.1:8080");
  });
});

describe("insecureEndpointsDecision", () => {
  it.each([
    [{}, true, "off"],
    [{ T3CODE_PUSH_ALLOW_INSECURE_ENDPOINTS: "0" }, true, "off"],
    [{ T3CODE_PUSH_ALLOW_INSECURE_ENDPOINTS: "1" }, false, "ignored"],
    [{ T3CODE_PUSH_ALLOW_INSECURE_ENDPOINTS: "1" }, true, "allowed"],
  ])("%j with development=%s is %s", (environment, development, expected) => {
    expect(insecureEndpointsDecision({ environment, development })).toBe(expected);
  });
});
