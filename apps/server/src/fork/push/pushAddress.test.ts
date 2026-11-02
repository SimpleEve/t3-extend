import { describe, expect, it } from "vite-plus/test";

import { isPublicAddress } from "./pushAddress.ts";

const policy = { localAddresses: ["203.0.113.77", "2606:4700:4700::7777"] };

describe("isPublicAddress", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("accepts the public address %s", (address) => {
    expect(isPublicAddress(address, policy)).toBe(true);
  });

  it.each([
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "this network"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "RFC 1918"],
    ["172.16.0.1", "RFC 1918"],
    ["172.31.255.255", "RFC 1918"],
    ["192.168.1.20", "RFC 1918"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT"],
    ["100.100.100.100", "Tailscale"],
    ["100.127.255.255", "CGNAT"],
    ["192.0.0.1", "IETF assignments"],
    ["192.0.2.1", "documentation"],
    ["198.51.100.1", "documentation"],
    ["203.0.113.1", "documentation"],
    ["192.88.99.1", "6to4 anycast"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["fe80::1%en0", "link-local with a zone"],
    ["fc00::1", "unique local"],
    ["fd12:3456::1", "unique local"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["100::1", "discard-only"],
    ["2001:db8::1", "documentation"],
    ["3fff::1", "documentation"],
    ["2001::1", "Teredo"],
    ["64:ff9b:1::1", "local-use NAT64"],
    ["::ffff:127.0.0.1", "mapped loopback"],
    ["::ffff:7f00:1", "mapped loopback, hex form"],
    ["::ffff:10.1.2.3", "mapped RFC 1918"],
    ["::ffff:a9fe:a9fe", "mapped metadata"],
    ["::ffff:100.64.0.1", "mapped CGNAT"],
    ["::127.0.0.1", "compatible loopback"],
    ["::10.0.0.1", "compatible RFC 1918"],
    ["64:ff9b::7f00:1", "NAT64 loopback"],
    ["64:ff9b::a9fe:a9fe", "NAT64 metadata"],
    ["64:ff9b::c0a8:101", "NAT64 RFC 1918"],
    ["2002:7f00:1::1", "6to4 loopback"],
    ["2002:a9fe:a9fe::1", "6to4 metadata"],
    ["2002:c0a8:101::1", "6to4 RFC 1918"],
    ["[::1]", "bracketed loopback"],
  ])("rejects %s (%s)", (address) => {
    expect(isPublicAddress(address, policy)).toBe(false);
  });

  it("rejects this machine's own addresses even when they look public", () => {
    expect(isPublicAddress("203.0.113.77", { localAddresses: [] })).toBe(false); // documentation range anyway
    expect(isPublicAddress("93.184.216.34", { localAddresses: ["93.184.216.34"] })).toBe(false);
    expect(isPublicAddress("2606:4700:4700::7777", policy)).toBe(false);
    expect(isPublicAddress("::ffff:93.184.216.34", { localAddresses: ["93.184.216.34"] })).toBe(
      false,
    );
    expect(
      isPublicAddress("2606:4700:4700:0:0:0:0:7777", { localAddresses: ["2606:4700:4700::7777"] }),
    ).toBe(false);
  });

  it("does not treat text that is not an address as public", () => {
    for (const text of ["", "example.com", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1::2::3", "::g"]) {
      expect(isPublicAddress(text, policy)).toBe(false);
    }
  });
});
